// server.js (CommonJS) — FinishFlow live engine (proxy)
// - endpoints: POST /execute, POST /api/execute
// - audioflow bgm: fail-open (returns bgm_download_url when available)
// - fixed output schema + parse stabilizer
// - simple rate limit
// Node >= 18 (uses global fetch)

const express = require("express");
const crypto = require("crypto");

// (이미 C-2-1에서 추가한 라인 유지 가능)
// eslint-disable-next-line no-unused-vars
const { createBgmWav } = require("./lib/audioflow_bgm");

const app = express();
app.use(express.json({ limit: "10mb" }));

/* =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const AUDIOFLOW_ENGINE_URL =
  process.env.AUDIOFLOW_ENGINE_URL || "https://audioflow-live.onrender.com";
const AUDIOFLOW_TIMEOUT_MS = Number(process.env.AUDIOFLOW_TIMEOUT_MS || 120000);

// rate limit
const RL_MAX_PER_MIN = Number(process.env.RL_MAX_PER_MIN || 10);

/* =========================
 * Helpers: rate limit
 * ========================= */
const rlMap = new Map(); // key: ip + minute, val: count

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
      return res.status(429).json(errorPayload("E-RATE-429", "Too many requests"));
    }
    return next();
  } catch (e) {
    // rate limit 실패해도 막지 않음
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
  // FinishFlow 고정 스키마(예시)
  // 실제 UI/worker가 기대하는 구조가 다르면 여기서만 맞추면 됨.
  return {
    longform: { title: "", script: "" },
    shorts: [
      { title: "", script: "" },
      { title: "", script: "" },
      { title: "", script: "" },
    ],
    thumbnails: [
      { text: "" },
      { text: "" },
      { text: "" },
    ],
    recommended_thumbnail_index: 0,
    meta: {
      model: OPENAI_MODEL,
    },
    bgm: {
      preset: "",
      duration_sec: 0,
      download_url: "",
    },
  };
}

function okPayload(data) {
  return { ok: true, code: null, data };
}

function errorPayload(code, message) {
  return { ok: false, code, message, data: baseSchema() };
}

// OpenAI 응답에서 텍스트 뽑기(Responses/ChatCompletions 모두 유사 대응)
function extractOutputText(openaiJson) {
  // Chat Completions
  const c1 = openaiJson?.choices?.[0]?.message?.content;
  if (typeof c1 === "string") return c1;

  // Responses API 형태(대략 대응)
  const out = openaiJson?.output?.[0]?.content?.[0]?.text;
  if (typeof out === "string") return out;

  // fallback
  return JSON.stringify(openaiJson || {});
}

// 모델이 ```json ... ``` 같은 걸 줘도 {} 구간만 잘라내기
function coerceToJsonString(text) {
  if (!text) return "";
  const s = text.toString();

  // code fence 제거
  const noFence = s.replace(/```json/gi, "```").replace(/```/g, "");

  // 첫 { 와 마지막 } 사이 추출
  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start >= 0 && end > start) return noFence.slice(start, end + 1);

  return noFence.trim();
}

// 값 보정(없어도 스키마가 깨지지 않게)
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

  // recommended index
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

  // rate limit이면 그냥 실패 처리(상위에서 fail-open)
  if (res.status === 429) {
    throw new Error("AUDIOFLOW_RATE_LIMIT");
  }

  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) {
    const code = j?.code || `HTTP_${res.status}`;
    throw new Error(`AUDIOFLOW_FAIL_${code}`);
  }

  const dl = j?.data?.audio?.download_url || "";
  return {
    preset,
    duration_sec: durationSec,
    download_url: dl ? `${AUDIOFLOW_ENGINE_URL}${dl}` : "",
  };
}

/* =========================
 * OpenAI call (Chat Completions)
 * ========================= */
function buildSystemPrompt() {
  // 고정 스키마 강제: ONLY JSON
  return `
You are FinishFlow Engine.
Return ONLY valid JSON (no markdown, no code fences).
Schema:
{
  "longform": { "title": string, "script": string },
  "shorts": [ { "title": string, "script": string }, {..}, {..} ],
  "thumbnails": [ { "text": string }, { "text": string }, { "text": string } ],
  "recommended_thumbnail_index": 0|1|2
}
Rules:
- Keep outputs concise but complete.
- Titles should be clickable; scripts should be ready to narrate.
- Do NOT include any extra keys.
`.trim();
}

function buildUserPrompt({ topic }) {
  // topic만 받아도 항상 결과가 나오도록
  const safeTopic = (topic || "").toString().trim() || "시니어 대상 설명형 콘텐츠";
  return `Topic: ${safeTopic}\nGenerate the JSON following the schema exactly.`;
}

async function callOpenAI({ topic }) {
  if (!OPENAI_API_KEY) {
    throw new Error("NO_OPENAI_KEY");
  }

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

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(OPENAI_API_KEY),
    model: OPENAI_MODEL,
    hasAudioFlowUrl: Boolean(AUDIOFLOW_ENGINE_URL),
    rateLimitPerMin: RL_MAX_PER_MIN,
  });
});

// execute handler
async function handleExecute(req, res) {
  const body = req.body || {};
  const topic =
    (body.topic ?? body.input ?? body.prompt ?? "").toString().trim() ||
    "시니어 대상 설명형 콘텐츠";

  // (선택) kind/duration을 UI/요청에서 받으면 반영 가능
  const kind = (body.kind || "default").toString();
  const durationSec = Number(body.durationSec || body.duration_sec || 90);

  // 1) BGM 먼저(실패해도 계속)
  let bgmInfo = null;
  try {
    bgmInfo = await requestAudioFlowBgm({ topic, kind, durationSec });
  } catch (e) {
    console.log("[BGM] skipped:", e?.message || e);
  }

  // 2) FinishFlow 결과 생성(OpenAI)
  let openaiJson;
  try {
    openaiJson = await callOpenAI({ topic });
  } catch (e) {
    console.log("[OPENAI] failed:", e?.message || e);
    return res.status(200).json(errorPayload("E-OPENAI-001", "OpenAI request failed"));
  }

  // 3) 파싱 안정화
  const outText = extractOutputText(openaiJson);
  const jsonString = coerceToJsonString(outText);

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    console.log("[PARSE] failed:", e?.message || e);
    // 파싱 실패해도 빈 스키마 반환
    const data = normalizeResult({}, bgmInfo);
    return res.status(200).json({ ok: false, code: "E-PARSE-001", data });
  }

  const data = normalizeResult(parsed, bgmInfo);
  return res.status(200).json(okPayload(data));
}

// 메인 엔드포인트
app.post("/execute", rateLimit, async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[EXECUTE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

// 호환/프록시용 별칭
app.post("/api/execute", rateLimit, async (req, res) => {
  try {
    await handleExecute(req, res);
  } catch (e) {
    console.log("[API_EXECUTE] fatal:", e?.message || e);
    return res.status(200).json(errorPayload("E-FATAL-001", "Unexpected error"));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`finishflow-live listening on ${PORT}`);
});
