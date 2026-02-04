/**
 * finishflow-live/server.js  (CommonJS)
 * FULL REPLACE
 *
 * Provides:
 * - GET  /            (plain text)
 * - GET  /health      (with build stamp)
 * - GET  /debug/env   (env + build stamp)
 * - POST /execute     (FinishFlow JSON + (optional) AudioFlow BGM URL)
 * - POST /api/execute (compat)
 * - POST /make        (Generate MP4 via make.js -> makeVideo)
 * - GET  /download    (Download MP4 by token via make.js token store)
 *
 * Node >= 18 (global fetch)
 */

const express = require("express");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "10mb" }));

/* =========================
 * BUILD STAMP (for verification)
 * ========================= */
const BUILD = "FFLIVE_2026-02-04_R3";
console.log("[BOOT] BUILD =", BUILD);

/* =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// AudioFlow (for /execute BGM URL attach)
const AUDIOFLOW_ENGINE_URL =
  process.env.AUDIOFLOW_ENGINE_URL || "https://audioflow-live.onrender.com";
const AUDIOFLOW_TIMEOUT_MS = Number(process.env.AUDIOFLOW_TIMEOUT_MS || 120000);

// rate limit (simple in-memory)
const RL_MAX_PER_MIN = Number(process.env.RL_MAX_PER_MIN || 20);
const rlMap = new Map(); // key ip:minute -> count

function rateLimit(req, res, next) {
  try {
    const ip =
      (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    const minute = Math.floor(Date.now() / 60000);
    const key = `${ip}:${minute}`;
    const cur = (rlMap.get(key) || 0) + 1;
    rlMap.set(key, cur);

    // cleanup best-effort
    for (const [k, v] of rlMap.entries()) {
      const m = Number(k.split(":").pop());
      if (Number.isFinite(m) && m < minute - 2) rlMap.delete(k);
    }

    if (cur > RL_MAX_PER_MIN) {
      return res.status(429).json({ ok: false, code: "E-RATE-429" });
    }
    return next();
  } catch {
    return next();
  }
}

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
      { title: "", script: "" },
    ],
    thumbnails: [{ text: "" }, { text: "" }, { text: "" }],
    recommended_thumbnail_index: 0,
    meta: { model: OPENAI_MODEL },
    bgm: { preset: "", duration_sec: 0, download_url: "" },
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
 * AudioFlow BGM (fail-open attach for /execute)
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
      body: JSON.stringify({ topic, preset, duration_sec: durationSec }),
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
 * OpenAI call (Chat Completions)
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
      { role: "user", content: buildUserPrompt({ topic }) },
    ],
    temperature: 0.7,
  };

  const r = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
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
 * Routes: basics
 * ========================= */
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`finishflow-live is running\nBUILD=${BUILD}\n`);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now(), build: BUILD });
});

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    build: BUILD,
    now: new Date().toISOString(),
    node: process.version,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    hasAudioFlowUrl: !!process.env.AUDIOFLOW_ENGINE_URL,
    audioflowUrl: process.env.AUDIOFLOW_ENGINE_URL || null,
    model: process.env.OPENAI_MODEL || OPENAI_MODEL,
    rateLimitPerMin: RL_MAX_PER_MIN,
  });
});

/* =========================
 * /execute (JSON result + optional BGM URL)
 * ========================= */
async function handleExecute(req, res) {
  const body = req.body || {};
  const topic =
    (body.topic ?? body.input ?? body.prompt ?? "").toString().trim() ||
    "시니어 대상 설명형 콘텐츠";

  const kind = (body.kind || "default").toString();
  const durationSec = Number(body.durationSec || body.duration_sec || 90);

  // 1) AudioFlow BGM attach (fail-open)
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

app.post("/execute", rateLimit, async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[EXECUTE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

app.post("/api/execute", rateLimit, async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[API_EXECUTE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

/* =========================
 * /make + /download (MP4 generation pipeline)
 * - make.js is ESM, so we dynamic-import it.
 * ========================= */
async function loadMakeModule() {
  // ESM dynamic import from CommonJS
  return await import("./make.js");
}

app.post("/make", rateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const topic =
      (body.topic ?? body.input ?? body.prompt ?? "").toString().trim() ||
      "시니어 대상 설명형 콘텐츠";

    const mod = await loadMakeModule();
    if (!mod || typeof mod.makeVideo !== "function") {
      return res.status(500).json({ ok: false, code: "E-MAKE-001" });
    }

    const result = await mod.makeVideo({ topic });
    return res.status(200).json(result);
  } catch (e) {
    console.log("[MAKE] failed:", e?.message || e);
    return res.status(200).json({ ok: false, code: "E-MAKE-500", message: String(e?.message || e) });
  }
});

app.get("/download", async (req, res) => {
  try {
    const token = (req.query?.token || "").toString().trim();
    if (!token) return res.status(400).send("missing token");

    const mod = await loadMakeModule();
    if (!mod || typeof mod.getDownloadPathByToken !== "function") {
      return res.status(500).send("download module missing");
    }

    const filePath = mod.getDownloadPathByToken(token);
    if (!filePath) return res.status(404).send("expired or invalid token");
    if (!fs.existsSync(filePath)) return res.status(404).send("file not found");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="finishflow-${token}.mp4"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.log("[DOWNLOAD] failed:", e?.message || e);
    return res.status(500).send("download error");
  }
});

/* =========================
 * Start
 * ========================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[finishflow-live] listening on ${PORT}`);
  console.log("[BOOT] BUILD =", BUILD);
});
