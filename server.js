/**
 * finishflow-live/server.js (CommonJS)
 * - GET /health
 * - GET /debug/env  (verify which code is running)
 * - POST /execute + /api/execute
 *
 * Node >= 18 (global fetch)
 */

const express = require("express");

const app = express();
app.use(express.json({ limit: "10mb" }));

/* =========================
 * BUILD STAMP (FOR DIAGNOSIS)
 * ========================= */
const __BUILD_STAMP__ = "finishflow-live__serverjs__2026-02-04__r1";
console.log("[BOOT] BUILD_STAMP =", __BUILD_STAMP__);

/* =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const AUDIOFLOW_ENGINE_URL =
  process.env.AUDIOFLOW_ENGINE_URL || "https://audioflow-live.onrender.com";
const AUDIOFLOW_TIMEOUT_MS = Number(process.env.AUDIOFLOW_TIMEOUT_MS || 120000);

/* =========================
 * Routes (PUT DEBUG FIRST)
 * ========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ✅ 이게 살아나야 “내가 수정한 server.js가 실행 중”이 확정됩니다.
app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    build: __BUILD_STAMP__,
    now: new Date().toISOString(),
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    hasAudioFlowUrl: !!process.env.AUDIOFLOW_ENGINE_URL,
    audioflowUrl: process.env.AUDIOFLOW_ENGINE_URL || null,
    model: process.env.OPENAI_MODEL || OPENAI_MODEL,
    port: PORT,
    node: process.version
  });
});

// 루트
app.get("/", (req, res) => {
  res
    .status(200)
    .setHeader("Content-Type", "text/plain; charset=utf-8")
    .send(`finishflow-live running\nBUILD=${__BUILD_STAMP__}\n`);
});

/* =========================
 * Helpers
 * ========================= */
async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function baseSchema() {
  return {
    longform: { title: "", script: "" },
    shorts: [
      { title: "", script: "" },
      { title: "", script: "" },
      { title: "", script: "" }
    ],
    thumbnails: [{ text: "" }, { text: "" }, { text: "" }],
    recommended_thumbnail_index: 0,
    meta: { model: OPENAI_MODEL },
    bgm: { preset: "", duration_sec: 0, download_url: "" }
  };
}

function okPayload(data) {
  return { ok: true, code: null, data };
}

function errorPayload(code, message) {
  return { ok: false, code, message, data: baseSchema() };
}

function extractOutputText(openaiJson) {
  const c1 = openaiJson?.choices?.[0]?.message?.content;
  if (typeof c1 === "string") return c1;

  const out = openaiJson?.output?.[0]?.content?.[0]?.text;
  if (typeof out === "string") return out;

  return JSON.stringify(openaiJson || {});
}

function coerceToJsonString(text) {
  if (!text) return "";
  const s = text.toString();
  const noFence = s.replace(/```json/gi, "```").replace(/```/g, "");

  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start >= 0 && end > start) return noFence.slice(start, end + 1);

  return noFence.trim();
}

function normalizeResult(parsed, bgmInfo) {
  const out = baseSchema();

  if (parsed?.longform?.title) out.longform.title = String(parsed.longform.title);
  if (parsed?.longform?.script) out.longform.script = String(parsed.longform.script);

  if (Array.isArray(parsed?.shorts)) {
    for (let i = 0; i < 3; i++) {
      const item = parsed.shorts[i] || {};
      out.shorts[i].title = item.title ? String(item.title) : "";
      out.shorts[i].script = item.script ? String(item.script) : "";
    }
  }

  if (Array.isArray(parsed?.thumbnails)) {
    for (let i = 0; i < 3; i++) {
      const item = parsed.thumbnails[i] || {};
      out.thumbnails[i].text = item.text ? String(item.text) : "";
    }
  }

  if (typeof parsed?.recommended_thumbnail_index === "number") {
    const idx = Math.max(0, Math.min(2, parsed.recommended_thumbnail_index));
    out.recommended_thumbnail_index = idx;
  }

  if (bgmInfo) {
    out.bgm.preset = bgmInfo.preset || "";
    out.bgm.duration_sec = bgmInfo.duration_sec || 0;
    out.bgm.download_url = bgmInfo.download_url || "";
  }

  return out;
}

/* =========================
 * AudioFlow BGM (fail-open)
 * ========================= */
function mapBgmPreset(kind) {
  if (kind === "shorts") return "UPBEAT_SHORTS";
  if (kind === "documentary") return "DOCUMENTARY";
  return "CALM_LOOP";
}

async function requestAudioFlowBgm({ topic, kind = "default", durationSec = 90 }) {
  const preset = mapBgmPreset(kind);

  const res = await fetchWithTimeout(
    `${AUDIOFLOW_ENGINE_URL}/make`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, preset, duration_sec: durationSec })
    },
    AUDIOFLOW_TIMEOUT_MS
  );

  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) {
    const code = j?.code || `HTTP_${res.status}`;
    throw new Error(`AUDIOFLOW_FAIL_${code}`);
  }

  const dlPath = j?.data?.audio?.download_url || "";
  const full = dlPath ? `${AUDIOFLOW_ENGINE_URL}${dlPath}` : "";

  return { preset, duration_sec: durationSec, download_url: full };
}

/* =========================
 * OpenAI call
 * ========================= */
function buildSystemPrompt() {
  return `
Return ONLY valid JSON (no markdown, no code fences).
Schema:
{
  "longform": { "title": string, "script": string },
  "shorts": [ { "title": string, "script": string }, {..}, {..} ],
  "thumbnails": [ { "text": string }, { "text": string }, { "text": string } ],
  "recommended_thumbnail_index": 0|1|2
}
Rules:
- Do NOT include any extra keys.
- Output must be parseable JSON.
`.trim();
}

function buildUserPrompt({ topic }) {
  const safeTopic = (topic || "").toString().trim() || "시니어 대상 설명형 콘텐츠";
  return `Topic: ${safeTopic}\nGenerate the JSON following the schema exactly.`;
}

async function callOpenAI({ topic }) {
  if (!OPENAI_API_KEY) throw new Error("NO_OPENAI_KEY");

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt({ topic }) }
    ],
    temperature: 0.7
  };

  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    },
    120000
  );

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OPENAI_HTTP_${r.status}:${t.slice(0, 200)}`);
  }

  return await r.json();
}

/* =========================
 * Execute
 * ========================= */
async function handleExecute(req, res) {
  const body = req.body || {};
  const topic =
    (body.topic ?? body.input ?? body.prompt ?? "").toString().trim() ||
    "시니어 대상 설명형 콘텐츠";

  const kind = (body.kind || "default").toString();
  const durationSec = Number(body.durationSec || body.duration_sec || 90);

  // 1) BGM (fail-open)
  let bgmInfo = null;
  try {
    bgmInfo = await requestAudioFlowBgm({ topic, kind, durationSec });
  } catch (e) {
    console.log("[BGM] skipped:", e?.message || e);
  }

  // 2) OpenAI
  let openaiJson;
  try {
    openaiJson = await callOpenAI({ topic });
  } catch (e) {
    console.log("[OPENAI] failed:", e?.message || e);
    const data = normalizeResult({}, bgmInfo);
    return res.status(200).json({ ok: false, code: "E-OPENAI-001", data });
  }

  // 3) Parse
  const outText = extractOutputText(openaiJson);
  const jsonString = coerceToJsonString(outText);

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    console.log("[PARSE] failed:", e?.message || e);
    const data = normalizeResult({}, bgmInfo);
    return res.status(200).json({ ok: false, code: "E-PARSE-001", data });
  }

  const data = normalizeResult(parsed, bgmInfo);
  return res.status(200).json(okPayload(data));
}

app.post("/execute", async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[EXECUTE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

app.post("/api/execute", async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[API_EXECUTE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[finishflow-live] listening on ${PORT}`);
  console.log("[BOOT] BUILD_STAMP =", __BUILD_STAMP__);
});
