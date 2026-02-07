require("dotenv").config();
console.log("[ENV] loaded:", !!process.env.OPENAI_API_KEY, "len:", (process.env.OPENAI_API_KEY || "").length);

const express = require("express");
const app = express();
app.use(express.json({ limit: "10mb" }));

/* =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 10000;
const BUILD = process.env.BUILD || "DEV";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* =========================
 * Helpers
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
 * OpenAI 응답 파싱
 * ========================= */

function extractOutputText(openaiJson) {
  const c1 = openaiJson?.choices?.[0]?.message?.content;

  if (typeof c1 === "string" && c1.trim()) return c1;

  if (Array.isArray(c1)) {
    const joined = c1
      .map(p => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        return "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  return "";
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

function normalizeResult(parsed) {
  const out = baseSchema();

  if (parsed?.longform?.title) out.longform.title = String(parsed.longform.title);
  if (parsed?.longform?.script) out.longform.script = String(parsed.longform.script);

  if (Array.isArray(parsed?.shorts)) {
    for (let i = 0; i < 3; i++) {
      const item = parsed.shorts[i] || {};
      out.shorts[i].title = item.title || "";
      out.shorts[i].script = item.script || "";
    }
  }

  if (Array.isArray(parsed?.thumbnails)) {
    for (let i = 0; i < 3; i++) {
      const item = parsed.thumbnails[i] || {};
      out.thumbnails[i].text = item.text || "";
    }
  }

  if (typeof parsed?.recommended_thumbnail_index === "number") {
    out.recommended_thumbnail_index = parsed.recommended_thumbnail_index;
  }

  return out;
}

/* =========================
 * Prompt
 * ========================= */

function buildSystemPrompt() {
  return `
Return ONLY valid JSON.
No explanation.
No markdown.

Schema:
{
  "longform": { "title": "string", "script": "string" },
  "shorts": [
    { "title": "string", "script": "string" },
    { "title": "string", "script": "string" },
    { "title": "string", "script": "string" }
  ],
  "thumbnails": [
    { "text": "string" },
    { "text": "string" },
    { "text": "string" }
  ],
  "recommended_thumbnail_index": 0
}
`.trim();
}

function buildUserPrompt({ topic, videoType, topicTone, durationSec }) {
  const safeTopic = topic || "시니어 건강 정보";
  return `
주제: ${safeTopic}
유형: ${videoType}
톤: ${topicTone}
길이: ${durationSec}초

한국어로 작성.
롱폼은 충분히 길게 작성.
숏폼 3개 작성.
썸네일 문구 3개 작성.
JSON만 출력.
`.trim();
}

/* =========================
 * OpenAI Call
 * ========================= */

async function callOpenAI({ topic, videoType, topicTone, durationSec }) {
  if (!OPENAI_API_KEY) throw new Error("NO_OPENAI_KEY");

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt({ topic, videoType, topicTone, durationSec }) },
    ],
    temperature: 0.7,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error("OPENAI_HTTP_" + t);
  }

  return await r.json();
}

/* =========================
 * Main Execute
 * ========================= */

async function handleExecute(req, res) {
  const body = req.body || {};
  const topic = body.topic || "시니어 건강";
  const videoType = body.videoType || "LONG";
  const topicTone = body.topicTone || "CALM";
  const durationSec = body.durationSec || 900;

  let openaiJson;
  try {
    openaiJson = await callOpenAI({ topic, videoType, topicTone, durationSec });
  } catch (e) {
    console.log(e);
    return res.json(errorPayload("E-OPENAI", "openai failed"));
  }

  const outText = extractOutputText(openaiJson);
  const jsonString = coerceToJsonString(outText);

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    console.log("parse fail:", jsonString);
    return res.json(errorPayload("E-PARSE", "parse failed"));
  }

  const data = normalizeResult(parsed);
  return res.json(okPayload(data));
}

/* =========================
 * Routes
 * ========================= */

app.get("/", (req, res) => {
  res.send("finishflow-live is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    model: OPENAI_MODEL,
  });
});

app.post("/make", async (req, res) => {
  await handleExecute(req, res);
});

app.post("/execute", async (req, res) => {
  await handleExecute(req, res);
});

/* =========================
 * Listen
 * ========================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[finishflow-live] listening on ${PORT}`);
  console.log(`[BOOT] BUILD=${BUILD}`);
});
