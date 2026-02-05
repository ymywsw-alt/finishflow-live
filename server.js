/**
 * finishflow-live/server.js (CommonJS)  ✅ FULL REPLACE
 *
 * Goals (고정):
 * - GET /              : "finishflow-live is running" + BUILD
 * - GET /health        : ok
 * - GET /debug/env     : ok + key flags (Cannot GET 방지)
 * - POST /execute      : main API (JSON schema)
 * - POST /api/execute  : compat
 * - POST /make         : alias (기존 습관/테스트용) ✅ 반드시 "/make" 슬래시 포함
 *
 * Node >= 18 (Render Node22 OK) : global fetch 사용
 */

const express = require("express");

// ✅ already exists in your repo: ./lib/audioflow_bgm.js (CommonJS)
const { createBgmWav } = require("./lib/audioflow_bgm");

// ✅ you created/converted: ./lib/bgm_selector.js (CommonJS)
// - if it doesn't exist or fails, we fallback safely (fail-open)
let selectBGMPreset = null;
try {
  // expect: module.exports = { selectBGMPreset } OR module.exports = function ...
  const mod = require("./lib/bgm_selector");
  selectBGMPreset = mod?.selectBGMPreset || mod;
} catch (e) {
  console.log("[BOOT] bgm_selector not loaded (ok):", e?.message || e);
}

/* =========================
 * App
 * ========================= */
const app = express();
app.use(express.json({ limit: "10mb" }));

/* =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 10000;
const BUILD = process.env.BUILD || process.env.RENDER_GIT_COMMIT || "DEV";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// AudioFlow Live URL (you already use this name)
const AUDIOFLOW_ENGINE_URL =
  process.env.AUDIOFLOW_ENGINE_URL || "https://audioflow-live.onrender.com";
const AUDIOFLOW_TIMEOUT_MS = Number(process.env.AUDIOFLOW_TIMEOUT_MS || 120000);

// simple rate limit
const RL_MAX_PER_MIN = Number(process.env.RL_MAX_PER_MIN || 20);

/* =========================
 * Helpers: rate limit
 * ========================= */
const rlMap = new Map(); // ip:minute -> count

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

    // cleanup (best-effort)
    for (const [k, v] of rlMap.entries()) {
      if (!k.endsWith(`:${minute}`) && v <= 0) rlMap.delete(k);
    }

    if (cur > RL_MAX_PER_MIN) {
      return res.status(429).json(errorPayload("E-RATE-429", "Too many requests"));
    }
    return next();
  } catch (e) {
    return next();
  }
}

/* =========================
 * Helpers: fetch with timeout
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

/* =========================
 * Helpers: schema
 * ========================= */
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
    meta: { model: OPENAI_MODEL, build: BUILD },
    bgm: { preset: "", duration_sec: 0, download_url: "" },
  };
}

function okPayload(data) {
  return { ok: true, code: null, data };
}

function errorPayload(code, message) {
  return { ok: false, code, message, data: baseSchema() };
}

/* =========================
 * Helpers: OpenAI output parse (E-PARSE-001)
 * ========================= */
function extractOutputText(openaiJson) {
  // Chat Completions
  const c1 = openaiJson?.choices?.[0]?.message?.content;
  if (typeof c1 === "string") return c1;

  // (fallback) Responses 형태
  const out = openaiJson?.output?.[0]?.content?.[0]?.text;
  if (typeof out === "string") return out;

  return JSON.stringify(openaiJson || {});
}

function coerceToJsonString(text) {
  if (!text) return "";
  const s = text.toString();

  // remove ``` fences
  const noFence = s.replace(/```json/gi, "```").replace(/```/g, "");

  // extract first { ... last }
  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start >= 0 && end > start) return noFence.slice(start, end + 1);

  return noFence.trim();
}

function normalizeResult(parsed, bgmInfo) {
  const out = baseSchema();

  // longform
  if (parsed?.longform?.title) out.longform.title = String(parsed.longform.title);
  if (parsed?.longform?.script) out.longform.script = String(parsed.longform.script);

  // shorts
  if (Array.isArray(parsed?.shorts)) {
    for (let i = 0; i < 3; i++) {
      const item = parsed.shorts[i] || {};
      out.shorts[i].title = item.title ? String(item.title) : "";
      out.shorts[i].script = item.script ? String(item.script) : "";
    }
  }

  // thumbnails
  if (Array.isArray(parsed?.thumbnails)) {
    for (let i = 0; i < 3; i++) {
      const item = parsed.thumbnails[i] || {};
      out.thumbnails[i].text = item.text ? String(item.text) : "";
    }
  }

  // recommended idx
  if (typeof parsed?.recommended_thumbnail_index === "number") {
    const idx = Math.max(0, Math.min(2, parsed.recommended_thumbnail_index));
    out.recommended_thumbnail_index = idx;
  }

  // bgm
  if (bgmInfo) {
    out.bgm.preset = bgmInfo.preset || "";
    out.bgm.duration_sec = bgmInfo.duration_sec || 0;
    out.bgm.download_url = bgmInfo.download_url || "";
  }

  return out;
}

/* =========================
 * BGM preset selection (auto, no user choice)
 * ========================= */
function pickPreset({ videoType, topicTone, durationSec }) {
  // use your lib if available
  try {
    if (typeof selectBGMPreset === "function") {
      return selectBGMPreset({ videoType, topicTone, durationSec });
    }
  } catch (e) {
    console.log("[BGM] selector failed, fallback:", e?.message || e);
  }

  // fallback rule
  const dur = Number(durationSec || 0);
  const vt = (videoType || "").toString().toUpperCase();
  const tone = (topicTone || "").toString().toUpperCase();

  if (vt === "SHORT" || (Number.isFinite(dur) && dur > 0 && dur <= 60)) return "UPBEAT_SHORTS";
  if (tone === "INFO" || tone === "DOCUMENTARY") return "DOCUMENTARY";
  return "CALM_LOOP";
}

/* =========================
 * AudioFlow BGM (fail-open)
 * ========================= */
async function requestAudioFlowBgm({ topic, preset, durationSec }) {
  const res = await fetchWithTimeout(
    `${AUDIOFLOW_ENGINE_URL}/make`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        preset,
        duration_sec: durationSec,
      }),
    },
    AUDIOFLOW_TIMEOUT_MS
  );

  // rate-limit propagate as error (will still fail-open)
  if (res.status === 429) throw new Error("AUDIOFLOW_RATE_LIMIT");

  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) {
    const code = j?.code || `HTTP_${res.status}`;
    throw new Error(`AUDIOFLOW_FAIL_${code}`);
  }

  // assume: { ok:true, data:{ audio:{ download_url:"/download/xxx.wav" } } }
  const dlPath = j?.data?.audio?.download_url || j?.data?.download_url || "";
  const full = dlPath
    ? dlPath.startsWith("http")
      ? dlPath
      : `${AUDIOFLOW_ENGINE_URL}${dlPath}`
    : "";

  return {
    preset,
    duration_sec: durationSec,
    download_url: full,
  };
}

async function createBgmFailOpen({ topic, videoType, topicTone, durationSec }) {
  const preset = pickPreset({ videoType, topicTone, durationSec });

  // 1) AudioFlow first
  try {
    return await requestAudioFlowBgm({ topic, preset, durationSec });
  } catch (e) {
    console.log("[BGM] audioflow skipped:", e?.message || e);
  }

  // 2) local generator (if exists)
  try {
    const r = await createBgmWav({ topic, preset, durationSec });
    if (r && r.download_url) {
      return {
        preset,
        duration_sec: durationSec,
        download_url: r.download_url,
      };
    }
  } catch (e) {
    console.log("[BGM] local skipped:", e?.message || e);
  }

  return null;
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
  "shorts": [
    { "title": string, "script": string },
    { "title": string, "script": string },
    { "title": string, "script": string }
  ],
  "thumbnails": [
    { "text": string }, { "text": string }, { "text": string }
  ],
  "recommended_thumbnail_index": 0|1|2
}
Rules:
- Do NOT include any extra keys.
- Output must be parseable JSON.
- Write Korean for Korean topics.
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
    temperature: 0.6,
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
 * Routes
 * ========================= */
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(`finishflow-live is running\nBUILD=${BUILD}`);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now(), build: BUILD });
});

// ✅ debug/env (Cannot GET 방지)
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

/**
 * 핵심 실행 로직
 * body 지원 키:
 * - topic | input | prompt
 * - videoType: "LONG"|"SHORT"
 * - topicTone: "INFO"|"DOCUMENTARY"|"CALM"|"HEALTH" 등
 * - durationSec | duration_sec
 */
async function handleExecute(req, res) {
  const body = req.body || {};

  const topic =
    (body.topic ?? body.input ?? body.prompt ?? "").toString().trim() ||
    "시니어 대상 설명형 콘텐츠";

  const videoType = (body.videoType || body.video_type || "LONG").toString();
  const topicTone = (body.topicTone || body.topic_tone || "CALM").toString();
  const durationSec = Number(body.durationSec || body.duration_sec || 90);

  // 1) BGM (fail-open)
  let bgmInfo = null;
  try {
    bgmInfo = await createBgmFailOpen({ topic, videoType, topicTone, durationSec });
  } catch (e) {
    console.log("[BGM] fatal skipped:", e?.message || e);
  }

  // 2) OpenAI JSON generate
  let openaiJson;
  try {
    openaiJson = await callOpenAI({ topic });
  } catch (e) {
    console.log("[OPENAI] failed:", e?.message || e);
    const data = normalizeResult({}, bgmInfo);
    return res.status(200).json({ ok: false, code: "E-OPENAI-001", data });
  }

  // 3) parse 안정화
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

/**
 * ✅ Main endpoint
 */
app.post("/execute", rateLimit, async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[EXECUTE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

/**
 * ✅ compat
 */
app.post("/api/execute", rateLimit, async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[API_EXECUTE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

/**
 * ✅ /make 를 “살린다”
 * - 사람들이 습관적으로 /make 때릴 수 있으니 alias로 고정
 * - 반드시 "/make" (슬래시 포함)
 */
app.post("/make", rateLimit, async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[MAKE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

/* =========================
 * Listen
 * ========================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[finishflow-live] listening on ${PORT}`);
  console.log(`[BOOT] BUILD=${BUILD}`);
});
