import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// === STDOUT HARD LOCK: allow stdout ONLY via out() ===
const __stdoutWrite = process.stdout.write.bind(process.stdout);
globalThis.__ALLOW_STDOUT__ = false;

process.stdout.write = (chunk, encoding, cb) => {
  if (!globalThis.__ALLOW_STDOUT__) return true;
  return __stdoutWrite(chunk, encoding, cb);
};

// redirect console.log to stderr
console.log = (...a) => console.error("[make]", ...a);

// logs to stderr
function log(...a) { console.error("[make]", ...a); }

// only out() can write to stdout
function out(obj) {
  globalThis.__ALLOW_STDOUT__ = true;
  __stdoutWrite(JSON.stringify(obj) + "\n");
  globalThis.__ALLOW_STDOUT__ = false;
}

const SYSTEM = "Return JSON only.";

// ---------- helpers ----------
function must(v, name) {
  if (!v) throw new Error(`Missing required: ${name}`);
  return v;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function briefErr(e) {
  return {
    message: e?.message || String(e),
    name: e?.name,
    stack: (e?.stack || "").split("\n").slice(0, 10).join("\n"),
    code: e?.code,
    status: e?.status,
    cmd: e?.cmd,
    args: e?.args,
    stdout: e?.stdout,
    stderr: e?.stderr,
  };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false, ...opts });

    let stdout = "";
    let stderr = "";

    p.stdout?.on("data", (d) => (stdout += d.toString()));
    p.stderr?.on("data", (d) => (stderr += d.toString()));

    p.on("error", (e) =>
      reject(Object.assign(e, { cmd, args, stdout, stderr }))
    );

    p.on("close", (code) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      const err = new Error(`Command failed (code=${code}): ${cmd} ${args.join(" ")}`);
      err.code = code;
      err.cmd = cmd;
      err.args = args;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

// ---------- OpenAI wrappers ----------
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
  try { json = JSON.parse(text); } catch (_) {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(`OpenAI error ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json ?? {};
}

async function openaiBinary(url, payload) {
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

  if (!res.ok) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(`OpenAI error ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- LLM script ----------
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
  try { parsed = JSON.parse(raw); } catch (_) { parsed = { script: raw }; }

  const script = typeof parsed?.script === "string" ? parsed.script.trim() : String(raw || "").trim();
  if (!script) throw new Error("Empty script from OpenAI");

  return {
    ok: true,
    parsed: {
      script,
      video_path: null,
      tts_path: null,
      id: crypto.randomBytes(6).toString("hex"),
      durationSec,
      videoType,
      topicTone,
      topic,
    },
    download_url: null,
  };
}

// ---------- TTS ----------
async function generateTTSMp3({ id, script, outDir }) {
  must(id, "id");
  must(script, "script");
  must(outDir, "outDir");

  ensureDir(outDir);

  const outMp3Path = path.join(outDir, `${id}.mp3`);

  // TTS (Audio API /v1/audio/speech)
  const audioBuf = await openaiBinary("https://api.openai.com/v1/audio/speech", {
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    format: "mp3",
    input: script,
  });

  fs.writeFileSync(outMp3Path, audioBuf);
  return outMp3Path;
}

// ---------- VIDEO (minimal, deterministic) ----------
async function makeVideo({ id, ttsPath, outDir, durationSec }) {
  must(id, "id");
  must(ttsPath, "ttsPath");
  must(outDir, "outDir");

  ensureDir(outDir);

  // ffmpeg 존재 확인 (없으면 여기서 원인 확정)
  try {
    const v = await run("ffmpeg", ["-version"]);
    const line = (v.stdout || v.stderr || "").split("\n")[0];
    log("[ffmpeg] installed:", line);
  } catch (e) {
    const err = new Error("ffmpeg not found or not runnable on this instance");
    err.stderr = e?.stderr;
    throw err;
  }

  const outMp4Path = path.join(outDir, `${id}.mp4`);

  // 배경 단색 + TTS 오디오 합성 (이미지 없어도 무조건 동작)
  // -shortest로 오디오 길이 기준 종료
  // durationSec는 배경 source 길이(최소보장)로만 사용
  const safeDur = Math.max(5, Math.floor(Number(durationSec || 45)));
  const ffArgs = [
    "-y",
    "-loop", "1",
"-i", "/app/bg.jpg",
"-t", `${safeDur}`,
    "-i", ttsPath,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outMp4Path,
  ];

  log("[ffmpeg] cmd:", "ffmpeg", ffArgs.join(" "));
  const r = await run("ffmpeg", ffArgs, { cwd: outDir });
  if (r.stderr) log("[ffmpeg][stderr]", r.stderr);

  if (!fs.existsSync(outMp4Path)) throw new Error("Video not created (mp4 missing)");
  return outMp4Path;
}

// ---------- entry ----------
(async () => {
  const t0 = Date.now();
  try {
    const req = JSON.parse(fs.readFileSync("req.json", "utf-8"));

    const r = await safeMakeScript(req);
    const { id, script, durationSec } = r.parsed;

    const outDir = path.resolve(process.cwd(), "out", id);
    ensureDir(outDir);
// bg.jpg를 작업 폴더로 복사
const bgSrc = path.resolve(process.cwd(), "bg.jpg");
const bgDst = path.join(outDir, "bg.jpg");
if (!fs.existsSync(bgSrc)) throw new Error(`bg.jpg missing at ${bgSrc}`);
fs.copyFileSync(bgSrc, bgDst);

    const ttsPath = await generateTTSMp3({ id, script, outDir });
    log("ttsPath:", ttsPath);

    const videoPath = await makeVideo({ id, ttsPath, outDir, durationSec });
    log("videoPath:", videoPath);

    r.parsed.tts_path = ttsPath;
    r.parsed.video_path = videoPath;

    // stdout 단 1회
    out({
      ok: true,
      parsed: r.parsed,
      download_url: null,
      ms: Date.now() - t0
    });

  } catch (e) {
    const info = briefErr(e);
    log("FAIL:", info);

    // stdout 단 1회
    out({
      ok: false,
      error: info,
      ms: Date.now() - t0
    });

    process.exitCode = 1;
  }
})();

