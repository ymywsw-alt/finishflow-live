// finishflow-live / make.js  (FULL REPLACE)
// - ES Module style (works on Node 18+; may show a harmless warning if package.json lacks "type":"module")
// - Reads ./req.json
// - Generates script -> TTS mp3 -> ffprobe duration -> ffmpeg mp4 (+ optional AudioFlow BGM mix)
// - Prints ONE JSON line at the end (server.js parses the last JSON line)

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";

// ====== C-stage selector (CommonJS module from ./lib) ======
const require = createRequire(import.meta.url);
let selectBGMPreset = null;
try {
  ({ selectBGMPreset } = require("./lib/bgm_selector"));
} catch {
  selectBGMPreset = null; // fail-open
}

// ====== helpers ======
function run(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
      reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(
        new Error(
          `${cmd} failed (code=${code}). stderr:\n${stderr}\nstdout:\n${stdout}`
        )
      );
    });
  });
}

function safeFileName(s) {
  return s.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 40) || "x";
}

// 간단 전처리(발음 개선 최소치)
function preprocessKoreanTTS(text) {
  let t = String(text || "");

  t = t.replace(/~/g, "에서 ");
  t = t.replace(/\bAI\b/gi, "에이아이");
  t = t.replace(/\s+/g, " ").trim();

  // 너무 긴 문장 쪼개기: 문장부호/종결 기준
  const parts = t
    .split(/(?<=[\.\!\?]|다\.)\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

  return parts.join(", ");
}

// ====== OpenAI calls via HTTPS (no SDK dependency) ======
async function openaiJSON(url, body) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set in Render Environment");

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`OpenAI error ${r.status}: ${text.slice(0, 500)}`);
  }
  return r.json();
}

async function openaiBinary(url, body) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set in Render Environment");

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`OpenAI error ${r.status}: ${text.slice(0, 500)}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// ====== Script generation (spoken style) ======
async function generateScript(topic) {
  const data = await openaiJSON("https://api.openai.com/v1/chat/completions", {
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You write Korean voiceover scripts that sound natural for middle-aged/older audiences. Use short spoken sentences. Add natural pauses. Sound like a calm YouTube narrator speaking slowly and clearly. Avoid hype."
      },
      {
        role: "user",
        content: `주제: "${topic}"\n\n요구사항:\n- 45~60초 분량\n- 문장 짧게\n- 어려운 용어 금지\n- 마지막은 행동 1가지로 끝내기\n- 말하듯이 쓰기 (설명문체 금지)\n\n스크립트만 출력`
      }
    ],
    temperature: 0.4
  });

  const text = (data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("Empty script from OpenAI");
  return text;
}

// ====== TTS (mp3) ======
// 업그레이드: gpt-4o-mini-tts (체감 품질 상승)
// voice/speed는 유지
async function generateTTSMp3(scriptText) {
  const cleaned = preprocessKoreanTTS(scriptText);

  const mp3 = await openaiBinary("https://api.openai.com/v1/audio/speech", {
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    format: "mp3",
    speed: 0.97,
    input: cleaned
  });

  return { mp3, cleaned };
}

// ffprobe로 오디오 길이(초) 구하기
async function getDurationSeconds(audioPath) {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath
    ],
    { timeoutMs: 60000 }
  );

  const s = stdout.trim();
  const val = Number(s);
  if (!Number.isFinite(val) || val <= 0) {
    throw new Error(`Invalid duration from ffprobe: "${s}"`);
  }

  return Math.max(3, val);
}

// ====== AudioFlow BGM (fail-open) ======
function getAudioflowEngineUrl() {
  return (
    process.env.AUDIOFLOW_ENGINE_URL ||
    process.env.AUDIOFLOW_URL ||
    "https://audioflow-live.onrender.com"
  );
}

function pickPreset({ durationSec = 60 }) {
  try {
    if (typeof selectBGMPreset === "function") {
      return selectBGMPreset({
        videoType: durationSec <= 60 ? "SHORT" : "LONG",
        topicTone: durationSec <= 60 ? "UPBEAT" : "CALM",
        durationSec
      });
    }
  } catch {}
  return durationSec <= 60 ? "UPBEAT_SHORTS" : "CALM_LOOP";
}

async function requestAudioFlowBgm({ topic, durationSec }) {
  const AUDIOFLOW_ENGINE_URL = getAudioflowEngineUrl();
  const preset = pickPreset({ durationSec });

  const timeoutMs = Number(process.env.AUDIOFLOW_TIMEOUT_MS || 120000);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(`${AUDIOFLOW_ENGINE_URL}/make`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        topic,
        preset,
        duration_sec: Math.round(durationSec)
      })
    });

    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) {
      const code = j?.code || `HTTP_${r.status}`;
      throw new Error(`AUDIOFLOW_FAIL_${code}`);
    }

    const dlPath = j?.data?.audio?.download_url || "";
    const full = dlPath ? `${AUDIOFLOW_ENGINE_URL}${dlPath}` : "";
    if (!full) throw new Error("AUDIOFLOW_NO_DOWNLOAD_URL");

    return { preset, download_url: full };
  } finally {
    clearTimeout(t);
  }
}

async function downloadToFile(url, outPath) {
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Download failed ${r.status}: ${t.slice(0, 200)}`);
  }
  const ab = await r.arrayBuffer();
  fs.writeFileSync(outPath, Buffer.from(ab));
  return outPath;
}

// ffmpeg로 “오디오 길이만큼” 영상 만들기 (+ 선택: BGM 믹스)
async function renderMp4({ title, voiceAudioPath, bgmPath, outPath, durationSec }) {
  const safeTitle = (title || "")
    .toString()
    .replace(/'/g, "’")
    .slice(0, 22);

  const draw = `drawtext=fontcolor=white:fontsize=52:text='${safeTitle}':x=(w-text_w)/2:y=(h-text_h)/2`;

  // 기본(음성만)
  if (!bgmPath) {
    const args = [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=1280x720:r=30:d=${durationSec}`,
      "-i",
      voiceAudioPath,
      "-vf",
      draw,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      outPath
    ];

    await run("ffmpeg", args, { timeoutMs: 240000 });
    return;
  }

  // BGM 포함(음성 + BGM 믹싱)
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=1280x720:r=30:d=${durationSec}`,
    "-i",
    voiceAudioPath,
    "-stream_loop",
    "-1",
    "-i",
    bgmPath,
    "-vf",
    draw,
    "-filter_complex",
    [
      "[1:a]aformat=fltp:44100:stereo,volume=1.0[a1]",
      "[2:a]aformat=fltp:44100:stereo,volume=0.35[a2]",
      "[a1][a2]amix=inputs=2:duration=first:dropout_transition=0[aout]"
    ].join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-t",
    `${durationSec}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    outPath
  ];

  await run("ffmpeg", args, { timeoutMs: 300000 });
}

// mp4 유효성 체크 (스트림 존재 + 길이>2초)
async function validateMp4(mp4Path) {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      mp4Path
    ],
    { timeoutMs: 60000 }
  );
  if (!stdout.trim()) throw new Error("MP4 has no video stream");

  const { stdout: durOut } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      mp4Path
    ],
    { timeoutMs: 60000 }
  );
  const d = Number(durOut.trim());
  if (!Number.isFinite(d) || d < 2.5) {
    throw new Error(`MP4 duration too short: ${durOut.trim()}`);
  }
}

// ====== main: make video ======
export async function makeVideo({ topic }) {
  const id = crypto.randomBytes(6).toString("hex");
  const tmpDir = os.tmpdir();

  const voicePath = path.join(tmpDir, `finishflow-${id}.mp3`);
  const bgmLocalPath = path.join(tmpDir, `finishflow-${id}-bgm.wav`);
  const mp4Path = path.join(tmpDir, `finishflow-${id}.mp4`);

  // 1) script
  const script = await generateScript(topic);

  // 2) tts
  const { mp3, cleaned } = await generateTTSMp3(script);
  fs.writeFileSync(voicePath, mp3);

  // 3) duration
  const durationSec = await getDurationSeconds(voicePath);

  // 4) try AudioFlow BGM (fail-open)
  let bgmInfo = null;
  let bgmPath = null;
  try {
    bgmInfo = await requestAudioFlowBgm({ topic, durationSec });
    if (bgmInfo?.download_url) {
      await downloadToFile(bgmInfo.download_url, bgmLocalPath);
      bgmPath = bgmLocalPath;
    }
  } catch (e) {
    console.log("[BGM] skipped:", e?.message || e);
    bgmInfo = null;
    bgmPath = null;
  }

  // 5) render mp4
  await renderMp4({
    title: topic,
    voiceAudioPath: voicePath,
    bgmPath,
    outPath: mp4Path,
    durationSec
  });

  // 6) validate
  await validateMp4(mp4Path);

  // NOTE:
  // - server.js now issues the FINAL download token.
  // - We still return video_path for server.js to create its own token.
  return {
    ok: true,
    step: 4,
    topic,
    audio_generated: true,
    video_generated: true,
    video_path: mp4Path,
    meta: {
      duration_sec: Math.round(durationSec),
      tts_input_preview: cleaned.slice(0, 120),
      bgm_used: !!bgmPath,
      bgm_preset: bgmInfo?.preset || "",
      bgm_download_url: bgmInfo?.download_url || ""
    }
  };
}

// ====== direct run: read req.json and print JSON ======
function readReqJson() {
  const p = path.join(process.cwd(), "req.json");
  const raw = fs.readFileSync(p, "utf-8");
  const j = JSON.parse(raw);
  return j || {};
}

async function main() {
  const req = readReqJson();
  const topic = typeof req?.topic === "string" ? req.topic.trim() : "";
  if (!topic) throw new Error("req.json missing topic");

  const r = await makeVideo({ topic });

  // Print exactly one JSON line at the end (server.js parses this)
  console.log(JSON.stringify(r));
}

// ESM direct-run detection
const isDirectRun =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")) ||
    import.meta.url.endsWith("file://" + process.argv[1].replace(/\\/g, "/")));

if (isDirectRun) {
  main().catch((e) => {
    const out = {
      ok: false,
      error: e?.message || String(e),
      where: "make.js"
    };
    console.log(JSON.stringify(out));
    process.exit(1);
  });
}
