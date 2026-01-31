import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

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
        content:
          "You write Korean voiceover scripts that sound natural for middle-aged/older audiences. Keep it calm, clear, and practical. Avoid hype."
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
    model: "tts-1",
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

// ffmpeg로 “오디오 길이만큼” 영상 만들기
async function renderMp4({ title, audioPath, outPath, durationSec }) {
  // 배경: black 1280x720, 30fps, durationSec
  // 텍스트: 제목 중앙
  // 오디오: AAC 192k
  const draw = `drawtext=fontcolor=white:fontsize=52:text='${title
    .replace(/'/g, "’")
    .slice(0, 22)}':x=(w-text_w)/2:y=(h-text_h)/2`;

  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=1280x720:r=30:d=${durationSec}`,
    "-i",
    audioPath,
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

  const audioPath = path.join(tmpDir, `finishflow-${id}.mp3`);
  const mp4Path = path.join(tmpDir, `finishflow-${id}.mp4`);

  // 1) script
  const script = await generateScript(topic);

  // 2) tts
  const { mp3, cleaned } = await generateTTSMp3(script);
  fs.writeFileSync(audioPath, mp3);

  // 3) duration
  const durationSec = await getDurationSeconds(audioPath);

  // 4) render mp4 (duration = audio duration)
  await renderMp4({
    title: topic,
    audioPath,
    outPath: mp4Path,
    durationSec
  });

  // 5) validate playable mp4
  await validateMp4(mp4Path);

  // 6) token for download
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
      tts_input_preview: cleaned.slice(0, 120)
    }
  };
}
