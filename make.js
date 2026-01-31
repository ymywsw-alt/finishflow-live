const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const TTS_MODEL = process.env.TTS_MODEL || "gpt-4o-mini-tts"; // 바뀌면 Render env에서만 수정

// 메모리 토큰 저장 (서버 재시작되면 초기화됨)
const tokenStore = new Map();

/** 안전: ffmpeg 존재 확인 */
async function assertFfmpeg() {
  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-version"]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error("ffmpeg not available"));
    });
    p.on("error", reject);
  });
}

/** OpenAI TTS (npm openai 패키지 없이 fetch로 직접 호출) */
async function generateAudioMp3(text, outPath) {
  if (!OPENAI_API_KEY) {
    // 키가 없으면 “빈 파일” 만들지 말고 실패 처리
    throw new Error("OPENAI_API_KEY is missing");
  }

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: "alloy",
      format: "mp3",
      input: text
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI TTS failed: ${resp.status} ${t}`);
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  const size = fs.statSync(outPath).size;
  if (size < 5_000) throw new Error("TTS produced too-small audio (failed)");
}

/**
 * mp3 -> mp4
 * - 검은 배경 + 오디오
 * - 재생성 보장 옵션 포함
 */
async function makePlayableMp4(mp3Path, mp4Path) {
  // 오디오 길이에 맞춰 영상 생성 (검은 화면 + 오디오)
  // -movflags +faststart : 웹 스트리밍/다운로드 재생 안정
  // -pix_fmt yuv420p     : 호환성 최상
  // -c:a aac             : 대부분 플레이어 호환
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=1280x720:r=30",
    "-i", mp3Path,
    "-shortest",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-tune", "stillimage",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    mp4Path
  ];

  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error("ffmpeg failed: " + err.slice(-2000)));
    });
    p.on("error", reject);
  });

  const size = fs.statSync(mp4Path).size;
  // ✅ “빈 mp4” 방지: 최소 크기 조건
  if (size < 200_000) {
    throw new Error(`mp4 too small (${size} bytes). Treat as failed.`);
  }
}

/** 토큰 생성 */
function newToken() {
  return crypto.randomBytes(16).toString("hex");
}

/** 주제 -> 간단 대본(지금은 최소 안정 버전) */
function buildScript(topic) {
  return [
    `주제: ${topic}`,
    "",
    "핵심 3가지:",
    "1) 수면을 먼저 고정한다 (매일 같은 시간)",
    "2) 혈당 스파이크를 피한다 (단백질/채소 먼저)",
    "3) 매일 20분 걷는다 (무리하지 않고 꾸준히)",
    "",
    "오늘부터 할 1가지:",
    "오늘 잠드는 시간을 30분 앞당기고, 내일부터 7일만 유지해보세요."
  ].join("\n");
}

/**
 * 메인: /make
 */
async function makeVideoJob({ topic, req }) {
  await assertFfmpeg();

  const tmpDir = os.tmpdir();
  const jobId = crypto.randomBytes(6).toString("hex");
  const audioPath = path.join(tmpDir, `finishflow-${jobId}.mp3`);
  const videoPath = path.join(tmpDir, `finishflow-${jobId}.mp4`);

  const script = buildScript(topic);

  // 1) audio
  await generateAudioMp3(script, audioPath);

  // 2) video
  await makePlayableMp4(audioPath, videoPath);

  // 3) token 저장(다운로드)
  const token = newToken();
  tokenStore.set(token, { videoPath, createdAt: Date.now() });

  // 4) 응답
  const host = req.get("host");
  const proto = (req.get("x-forwarded-proto") || "https").toString();
  const downloadUrl = `${proto}://${host}/download?token=${token}`;

  return {
    ok: true,
    step: 4,
    topic,
    audio_generated: true,
    video_generated: true,
    video_path: videoPath,
    download_url: downloadUrl
  };
}

/**
 * /download 토큰 처리: read stream 반환
 */
async function getDownloadByToken(token) {
  const rec = tokenStore.get(token);
  if (!rec) return null;

  // 파일 존재 확인
  if (!fs.existsSync(rec.videoPath)) return null;

  // (선택) 오래된 토큰 정리: 2시간 이상 삭제
  const now = Date.now();
  for (const [k, v] of tokenStore.entries()) {
    if (now - v.createdAt > 2 * 60 * 60 * 1000) {
      tokenStore.delete(k);
      try { fs.unlinkSync(v.videoPath); } catch {}
    }
  }

  return { stream: fs.createReadStream(rec.videoPath) };
}

module.exports = { makeVideoJob, getDownloadByToken };
