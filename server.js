// finishflow-live/server.js  (CommonJS)  ✅ FULL REPLACE
// Node >= 18 (global fetch). Windows/Render 모두 동일.
// Endpoints:
//  - GET  /            : "finishflow-live is running" + BUILD
//  - GET  /health      : ok
//  - GET  /debug/env   : ok + key flags
//  - POST /execute     : main API
//  - POST /api/execute : compat
//  - POST /make        : alias (반드시 /make 유지)

require("dotenv").config();

const http = require("http");
const url = require("url");

const BUILD = process.env.BUILD || "DEV";
const PORT = Number(process.env.PORT || 10000);
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const RATELIMIT_PER_MIN = Number(process.env.RATELIMIT_PER_MIN || 20);

console.log("[ENV] loaded:", !!process.env.OPENAI_API_KEY, "len:", (process.env.OPENAI_API_KEY || "").length);
console.log("[finishflow-live] listening on", PORT);
console.log("[BOOT] BUILD=" + BUILD);

// (BGM optional) keep your existing “skip” logs style
if (!process.env.AUDIOFLOW_URL) {
  console.log("[BGM] audioflow skipped: AUDIOFLOW_FAIL_HTTP_404");
  console.log("[BGM] local skipped: AUDIOFLOW_FAIL_HTTP_404");
}

// -------------------- tiny utilities --------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-trace-id",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-trace-id",
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("INVALID_JSON_BODY"));
      }
    });
  });
}

// -------------------- simple in-memory rate limit --------------------
const rl = {
  windowStart: Date.now(),
  count: 0,
};
function rateLimitCheck() {
  const now = Date.now();
  if (now - rl.windowStart > 60_000) {
    rl.windowStart = now;
    rl.count = 0;
  }
  rl.count += 1;
  if (rl.count > RATELIMIT_PER_MIN) return false;
  return true;
}

// -------------------- fetch with timeout --------------------
async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- schema helpers --------------------
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
    bgm: { preset: "", duration_sec: 0, download_url: "" },
    meta: { model: MODEL, build: BUILD },
  };
}

function coerceToJsonString(text) {
  const s = (text || "").toString();

  // remove ``` fences
  const noFence = s.replace(/```json/gi, "```").replace(/```/g, "");

  // extract first {...} block
  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start >= 0 && end > start) return noFence.slice(start, end + 1).trim();

  return noFence.trim();
}

// ✅ FIXED: handle ChatCompletions message.content as string OR array parts
function extractOutputText(openaiJson) {
  // 1) Chat Completions: choices[0].message.content
  const content = openaiJson?.choices?.[0]?.message?.content;

  // content: string
  if (typeof content === "string" && content.trim()) return content;

  // content: array of parts (e.g. [{type:"text", text:"..."}])
  if (Array.isArray(content)) {
    const joined = content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        if (typeof p?.content === "string") return p.content;
        if (typeof p?.value === "string") return p.value;
        return "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  // 2) Responses API: output_text
  const ot = openaiJson?.output_text;
  if (typeof ot === "string" && ot.trim()) return ot;

  // 3) Responses API: output array
  const output = openaiJson?.output;
  if (Array.isArray(output)) {
    const texts = [];
    for (const item of output) {
      if (!item) continue;

      if (typeof item?.text === "string") texts.push(item.text);

      if (Array.isArray(item?.content)) {
        for (const p of item.content) {
          if (!p) continue;
          if (typeof p?.text === "string") texts.push(p.text);
          if (typeof p?.content === "string") texts.push(p.content);
        }
      }
    }
    const joined = texts.join("\n").trim();
    if (joined) return joined;
  }

  // 4) Fallback: openaiJson.text (some wrappers)
  const t = openaiJson?.text;
  if (typeof t === "string" && t.trim()) return t;

  return "";
}

// -------------------- OpenAI call --------------------
async function callOpenAI(traceId, payload) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_KEY_MISSING");

  const url = "https://api.openai.com/v1/chat/completions";

  // ✅ 강제: JSON만 반환하도록 지시 (FinishFlow 용)
  const system = [
    "You are FinishFlow.",
    "Return ONLY valid JSON. No markdown. No commentary.",
    "The JSON must match exactly this schema:",
    JSON.stringify(
      {
        longform: { title: "string", script: "string" },
        shorts: [{ title: "string", script: "string" }, { title: "string", script: "string" }, { title: "string", script: "string" }],
        thumbnails: [{ text: "string" }, { text: "string" }, { text: "string" }],
        recommended_thumbnail_index: 0,
        bgm: { preset: "string", duration_sec: 0, download_url: "string" },
      },
      null,
      2
    ),
  ].join("\n");

  const user = [
    "Input JSON:",
    JSON.stringify(payload, null, 2),
    "",
    "Rules:",
    "- longform.script must be long enough to match durationSec (approx).",
    "- shorts: 3 variants, each 30~50 sec script.",
    "- thumbnails: 3 high-CTR Korean texts for seniors. Avoid sensational false fear.",
    "- recommended_thumbnail_index: 0~2.",
    "- Keep it calm, decisive, practical.",
  ].join("\n");

  const reqBody = {
    model: MODEL,
    temperature: 0.6,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  console.log("[callOpenAI] REQUEST", { traceId, model: MODEL });

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(reqBody),
    },
    120000
  );

  const txt = await res.text();
  if (!res.ok) {
    console.log("[callOpenAI] HTTP_ERR", { traceId, status: res.status, bodyHead: txt.slice(0, 200) });
    throw new Error("OPENAI_HTTP_" + res.status);
  }

  let json;
  try {
    json = JSON.parse(txt);
  } catch (e) {
    console.log("[callOpenAI] PARSE_ERR_OPENAI_JSON", { traceId, txtHead: txt.slice(0, 200) });
    throw new Error("OPENAI_BAD_JSON");
  }

  const rawText = extractOutputText(json);
  console.log("[callOpenAI] rawTextLen", { traceId, len: rawText.length });

  return { openaiJson: json, rawText };
}

// -------------------- core make --------------------
async function handleMake(traceId, reqBody) {
  const started = Date.now();

  // input normalize
  const topic = (reqBody?.topic || "").toString().trim();
  const videoType = (reqBody?.videoType || "LONG").toString().trim().toUpperCase();
  const topicTone = (reqBody?.topicTone || "CALM").toString().trim().toUpperCase();
  const durationSec = Number(reqBody?.durationSec || 900);

  const input = { topic, videoType, topicTone, durationSec };

  // OpenAI
  const { rawText } = await callOpenAI(traceId, input);

  // parse model output JSON
  const jsonStr = coerceToJsonString(rawText);

  let data = baseSchema();
  let code = null;

  try {
    const parsed = JSON.parse(jsonStr);

    // minimal validation + fill
    data.longform = parsed.longform || data.longform;
    data.shorts = Array.isArray(parsed.shorts) && parsed.shorts.length ? parsed.shorts.slice(0, 3) : data.shorts;
    data.thumbnails =
      Array.isArray(parsed.thumbnails) && parsed.thumbnails.length
        ? parsed.thumbnails.slice(0, 3).map((t) => ({ text: (t?.text || "").toString() }))
        : data.thumbnails;

    const idx = Number(parsed.recommended_thumbnail_index);
    data.recommended_thumbnail_index = Number.isFinite(idx) ? Math.max(0, Math.min(2, idx)) : 0;

    data.bgm = parsed.bgm || data.bgm;
    data.meta = { model: MODEL, build: BUILD };
  } catch (e) {
    code = "PARSE_FAIL";
    data = baseSchema();
  }

  // Always keep stable response shape
  const resp = {
    ok: true,
    code,
    data,
    meta: data.meta,
    bgm: data.bgm,
    duration_ms: Date.now() - started,
  };

  return resp;
}

// -------------------- HTTP server --------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname || "/";
  const method = (req.method || "GET").toUpperCase();
  const traceId = (req.headers["x-trace-id"] || "").toString();

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-trace-id",
    });
    return res.end();
  }

  if (method === "GET" && path === "/") {
    return sendText(res, 200, `finishflow-live is running (${BUILD})`);
  }

  if (method === "GET" && path === "/health") {
    return sendJson(res, 200, { ok: true, build: BUILD });
  }

  if (method === "GET" && path === "/debug/env") {
    return sendJson(res, 200, {
      ok: true,
      build: BUILD,
      now: new Date().toISOString(),
      node: process.version,
      hasOpenAIKey: !!process.env.OPENAI_API_KEY,
      keyPrefix: (process.env.OPENAI_API_KEY || "").slice(0, 7),
      model: MODEL,
      ratelimitPerMin: RATELIMIT_PER_MIN,
      hasAudioFlowUrl: !!process.env.AUDIOFLOW_URL,
      audioflowUrl: process.env.AUDIOFLOW_URL || null,
    });
  }

  if (method === "POST" && (path === "/make" || path === "/execute" || path === "/api/execute")) {
    if (!rateLimitCheck()) {
      return sendJson(res, 429, { ok: false, code: "RATE_LIMIT", message: "Too many requests" });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { ok: false, code: "BAD_JSON", message: "Invalid JSON body" });
    }

    try {
      console.log("[/make] ENTER", { traceId, bodyLen: JSON.stringify(body || {}).length });
      const out = await handleMake(traceId, body);
      console.log("[/make] SEND", { traceId, code: out.code });
      return sendJson(res, 200, out);
    } catch (e) {
      console.log("[/make] ERROR", { traceId, err: e?.message });
      return sendJson(res, 500, { ok: false, code: "SERVER_ERR", message: e?.message || "error" });
    }
  }

  return sendJson(res, 404, { ok: false, code: "NOT_FOUND" });
});

server.on("error", (err) => {
  console.error("Server error:", err);
});

server.listen(PORT, "0.0.0.0");
