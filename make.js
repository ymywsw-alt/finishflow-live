import fs from "fs";
import crypto from "crypto";

// 기존 코드에서 이미 정의돼 있다고 가정: callResponses(userText)
// 만약 이 파일에서 callResponses가 원래 위쪽에 있었다면, 아래 import/require 대신
// 기존 callResponses 구현을 이 파일 상단에 그대로 유지하고, 이 파일을 전체교체할 때 함께 포함되어야 합니다.
// => 안전을 위해, 여기서는 callResponses를 "외부에 이미 존재"하지 않도록 아래에 최소 구현을 포함합니다.

async function openaiJSON(url, payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`OpenAI error ${res.status}: ${msg}`);
  }

  return json ?? {};
}

const SYSTEM = "Return JSON only.";

async function callResponses(userText) {
  const d = await openaiJSON("https://api.openai.com/v1/responses", {
    model: "gpt-4.1-mini",
    max_output_tokens: 900,
    input: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userText },
    ],
  });

  const out =
    (d.output_text || "").trim() ||
    (d.output?.[0]?.content?.find((c) => c.type === "output_text")?.text || "").trim();

  return out;
}

async function safeMakeScript(req) {
  const topic = typeof req.topic === "string" ? req.topic.trim() : "";
  const videoType = typeof req.videoType === "string" ? req.videoType : "SHORT";
  const topicTone = typeof req.topicTone === "string" ? req.topicTone : "CALM";
  const durationSec =
    typeof req.durationSec === "number" && Number.isFinite(req.durationSec) ? req.durationSec : 45;

  if (!topic) throw new Error("Missing topic");

  const userText =
    `topic: ${topic}\n` +
    `type: ${videoType}\n` +
    `tone: ${topicTone}\n` +
    `seconds: ${durationSec}\n` +
    `Write a Korean voiceover script.\n` +
    `Return JSON only in schema {"script":"..."}.\n` +
    `No markdown.`;

  const raw = await callResponses(userText);

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = { script: raw };
  }

  const script = typeof parsed?.script === "string" ? parsed.script.trim() : String(raw || "").trim();
  if (!script) throw new Error("Empty script from OpenAI");

  return {
    ok: true,
    parsed: {
      script,
      video_path: null,
      id: crypto.randomBytes(6).toString("hex"),
    },
    download_url: null,
  };
}

// entry: req.json 읽고 결과를 stdout JSON 한 줄로 출력
(async () => {
  try {
    const req = JSON.parse(fs.readFileSync("req.json", "utf-8"));
    const r = await safeMakeScript(req);
    console.log(JSON.stringify({ ok: true, parsed: r.parsed, download_url: r.download_url }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }));
    process.exitCode = 1;
  }
})();
