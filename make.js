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
  // ./lib/bgm_selector.js is CommonJS now
  ({ selectBGMPreset } = require("./lib/bgm_selector"));
} catch {
  // fail-open: selector missing -> fallback logic later
  selectBGMPreset = null;
}

// ====== in-memory token store (TTL) ======
const tokenStore = new Map(); // token -> { filePath, expiresAt }
const TTL_MS = 30 * 60 * 1000; // 30 minutes

function putToken(token, filePath) {
  const expiresAt = Date.now() + TTL_MS;
  tokenStore.set(token, { filePath, expiresAt });

  // best-effort cleanup
  for (const [k, v] of tokenStore.entries()) {
    if (v.expiresAt < Date.now()) tokenStore.delete(k);
  }
}

export function getDownloadPathByToken(token) {
  const v = tokenStore.get(token);
  if (!v) return null;
  if (v.expiresAt < Date.now()) {
    tokenStore.delete(token);
    return null;
  }
  return v.filePath;
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
  let t = text;

  // 숫자/기호 기본 정리(최소)
  t = t.replace(/~/g, "에서 ");
  t = t.replace(/\bAI\b/gi, "에이아이");
  t = t.replace(/\s+/g, " ").trim();

  // 너무 긴 문장 쪼개기: 마침표/물음표/느낌표 기준
  // (OpenAI TTS가 긴 문장에 약한 케이스 완화)
  const parts = t
    .split(/(?<=[\.\!\?]|다\.)\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

  // 부분을 다시 합치되, 쉼표를 넣어 호흡 유도
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

// 스크립트 생성: (안전한 “짧고 명확” 톤)
async function generateScript(topic) {
  // Chat Completions (안정적)
  const data = await openaiJSON("https://api.openai.com/v1/chat/completions", {
    model: "gpt-4o-mini",
    messages: [
        {
  role: "system",
  content: "You write Korean voiceover scripts that sound natural for middle-aged/older audiences. Use short spoken sentences. Add natural pauses. Sound like a calm YouTube narrator speaking slowly and clearly. Avoid hype."
},

      },
      {
        role: "user",
        content: `주제: "${topic}"\n\n요구사항:\n- 45~60초 분량\n- 문장 짧게\n- 어려운 용어 금지\n- 마지막은 행동 1가지로 끝내기\n\n스크립트만 출력`
      }
    ],
    temperature: 0.4
  });

  const text = (data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("Empty script from OpenAI");
  return text;
}

// TTS 생성 (mp3)
// 모델/보이스는 계정/정책에 따라 다를 수 있어, 가장 범용인 tts-1 사용
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

  // 너무 짧아지지 않게 최소 3초 보정
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
  // selector가 있으면 사용, 없으면 최소 fallback
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
  // - bgm은 loop, durationSec만큼 잘라서
  // - 음성 1.0 / bgm 0.35로 안정 믹스
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

  // 4) (NEW) try AudioFlow BGM (fail-open)
  let bgmInfo = null;
  let bgmPath = null;
  try {
    bgmInfo = await requestAudioFlowBgm({ topic, durationSec });
    if (bgmInfo?.download_url) {
      await downloadToFile(bgmInfo.download_url, bgmLocalPath);
      // 다운로드 성공하면 믹싱에 사용
      bgmPath = bgmLocalPath;
    }
  } catch (e) {
    // fail-open: bgm 없이도 영상 생성은 계속
    console.log("[BGM] skipped:", e?.message || e);
    bgmInfo = null;
    bgmPath = null;
  }

  // 5) render mp4 (duration = voice duration)  + (optional) bgm mix
  await renderMp4({
    title: topic,
    voiceAudioPath: voicePath,
    bgmPath, // 있으면 믹싱
    outPath: mp4Path,
    durationSec
  });

  // 6) validate playable mp4
  await validateMp4(mp4Path);

  // 7) token for download
  const token = crypto.randomBytes(12).toString("hex");
  putToken(token, mp4Path);

  return {
    ok: true,
    step: 4,
    topic,
    audio_generated: true,
    video_generated: true,
    video_path: mp4Path,
    download_url: `/download?token=${token}`,
    meta: {
      duration_sec: Math.round(durationSec),
      tts_input_preview: cleaned.slice(0, 120),
      // NEW: bgm meta (useful for debugging)
      bgm_used: !!bgmPath,
      bgm_preset: bgmInfo?.preset || "",
      bgm_download_url: bgmInfo?.download_url || ""
    }
  };
}// ====== CLI entry (so `node make.js` actually runs) ======
async function main() {
  try {
    // req.json 읽기 (server.js가 먼저 써둠)
    const reqPath = path.join(process.cwd(), "req.json");
    const raw = fs.readFileSync(reqPath, "utf-8");
    const req = JSON.parse(raw);

    const topic = (req?.topic || "").toString().trim();
    if (!topic) throw new Error("req.json missing topic");

    // 실행
    const result = await makeVideo({ topic });

    // server.js가 잡아갈 수 있게 "한 줄 JSON"로 출력
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (e) {
    console.error(e?.message || String(e));
    process.exit(1);
  }
}

// ESM에서 직접 실행될 때만 main() 호출
// ====== CLI entry (always run when called by `node make.js`) ======
if (process.argv.some((a) => a.endsWith("make.js"))) {
  main();
}


