/**
 * finishflow-live/server.js  (CommonJS)
 * - POST /execute + POST /api/execute
 * - GET /health
 * - GET /debug/env  ✅ (지금 Cannot GET 해결)
 * - AudioFlow BGM 연동 (fail-open)
 * - 고정 스키마 + 파싱 안정화(E-PARSE-001)
 * - 간단 in-memory rate limit
 *
 * Node >= 18 (global fetch 사용)
 */

const express = require("express");

// C-2-1에서 만든 모듈(이미 존재): ./lib/audioflow_bgm.js
// 사용은 '선택'이지만, 파일이 없으면 require에서 죽으니 반드시 존재해야 합니다.
const { createBgmWav } = require("./lib/audioflow_bgm");

const app = express();
app.use(express.json({ limit: "10mb" }));

/* =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ✅ 사용자가 Render에 넣은 키 이름에 맞춤
// (당신 화면: AUDIOFLOW_ENGINE_URL)
const AUDIOFLOW_ENGINE_URL =
  process.env.AUDIOFLOW_ENGINE_URL || "https://audioflow-live.onrender.com";

const AUDIOFLOW_TIMEOUT_MS = Number(process.env.AUDIOFLOW_TIMEOUT_MS || 120000);

// rate limit (기본 10회/분)
const RL_MAX_PER_MIN = Number(process.env.RL_MAX_PER_MIN || 10);

/* =========================
 * Helpers: rate limit
 * ========================= */
const rlMap = new Map(); // key: ip:minute -> count

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

    if (cur > RL_MAX_PER_MIN) {
      return res
        .status(429)
        .json(errorPayload("E-RATE-429", "Too many requests"));
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
 * Helpers: schema & parse
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
  // Chat Completions
  const c1 = openaiJson?.choices?.[0]?.message?.content;
  if (typeof c1 === "string") return c1;

  // Responses 형태(대략 대응)
  const out = openaiJson?.output?.[0]?.content?.[0]?.text;
  if (typeof out === "string") return out;

  return JSON.stringify(openaiJson || {});
}

function coerceToJsonString(text) {
  if (!text) return "";
  const s = text.toString();

  // ```json / ``` 제거
  const noFence = s.replace(/```json/gi, "```").replace(/```/g, "");

  // 첫 { ~ 마지막 } 추출
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
 * AudioFlow BGM (fail-open)
 * ========================= */
function mapBgmPreset(kind) {
  if (kind === "shorts") return "UPBEAT_SHORTS";
  if (kind === "documentary") return "DOCUMENTARY";
  return "CALM_LOOP";
}

// AudioFlow 엔진으로 /make 호출하여 wav 다운로드 url 받기
async function requestAudioFlowBgm({ topic, kind = "default", durationSec = 90 }) {
  const preset = mapBgmPreset(kind);

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

  if (res.status === 429) throw new Error("AUDIOFLOW_RATE_LIMIT");

  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) {
    const code = j?.code || `HTTP_${res.status}`;
    throw new Error(`AUDIOFLOW_FAIL_${code}`);
  }

  // AudioFlow 응답 가정: { ok:true, data:{ audio:{ download_url:"/files/xxx.wav" } } }
  const dlPath = j?.data?.audio?.download_url || "";
  const full = dlPath ? `${AUDIOFLOW_ENGINE_URL}${dlPath}` : "";

  return {
    preset,
    duration_sec: durationSec,
    download_url: full,
  };
}

// (선택) 로컬 합성 모듈을 쓰고 싶으면 이 함수로 교체 가능
async function createBgmFailOpen({ topic, kind, durationSec }) {
  // 1) AudioFlow 엔진 우선
  try {
    return await requestAudioFlowBgm({ topic, kind, durationSec });
  } catch (e) {
    console.log("[BGM] audioflow skipped:", e?.message || e);
  }

  // 2) 로컬 합성(있으면) 시도 — 실패해도 계속
  try {
    // createBgmWav가 반환하는 스펙은 프로젝트에 따라 다를 수 있으니
    // 여기서는 “있으면 실행” 정도로만 둡니다.
    const r = await createBgmWav({ topic, kind, durationSec });
    // r.download_url 같은 값을 반환하도록 구현되어 있다면 아래 매핑 수정
    if (r && r.download_url) {
      return {
        preset: mapBgmPreset(kind),
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
 * Routes
 * ========================= */
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send("finishflow-live engine is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ✅ 지금 "Cannot GET /debug/env" 해결용
app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    hasAudioFlowUrl: !!process.env.AUDIOFLOW_ENGINE_URL,
    audioflowUrl: process.env.AUDIOFLOW_ENGINE_URL || null,
    model: process.env.OPENAI_MODEL || OPENAI_MODEL,
    rateLimitPerMin: RL_MAX_PER_MIN,
  });
});

async function handleExecute(req, res) {
  const body = req.body || {};

  const topic =
    (body.topic ?? body.input ?? body.prompt ?? "").toString().trim() ||
    "시니어 대상 설명형 콘텐츠";

  const kind = (body.kind || "default").toString();
  const durationSec = Number(body.durationSec || body.duration_sec || 90);

  // 1) BGM 먼저(fail-open)
  let bgmInfo = null;
  try {
    bgmInfo = await createBgmFailOpen({ topic, kind, durationSec });
  } catch (e) {
    console.log("[BGM] fatal skipped:", e?.message || e);
  }

  // 2) FinishFlow 결과 생성(OpenAI)
  let openaiJson;
  try {
    openaiJson = await callOpenAI({ topic });
  } catch (e) {
    console.log("[OPENAI] failed:", e?.message || e);
    // 파싱을 거치지 않고도, bgm은 붙여서 반환(사용자 경험 유지)
    const data = normalizeResult({}, bgmInfo);
    return res.status(200).json({ ok: false, code: "E-OPENAI-001", data });
  }

  // 3) 파싱 안정화
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

// 호환 엔드포인트
app.post("/api/execute", rateLimit, async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[API_EXECUTE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[finishflow-live] listening on ${PORT}`);
});
