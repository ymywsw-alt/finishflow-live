const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const OpenAI = require("openai");

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function fileSize(filePath) {
  const st = await fs.promises.stat(filePath);
  return st.size;
}

/**
 * 핵심: "빈 MP4(10KB)" 같은 거짓 성공을 막는다.
 * - ffmpeg exit code 검사
 * - 파일 존재 검사
 * - 파일 크기 검사(최소 바이트)
 */
async function validateMp4(mp4Path) {
  if (!fs.existsSync(mp4Path)) return { ok: false, reason: "mp4_missing" };
  const size = await fileSize(mp4Path);

  // 12초 영상이면 정상 MP4는 최소 수십~수백KB 이상.
  // 안전하게 120KB 미만은 실패로 본다.
  if (size < 120 * 1024) return { ok: false, reason: "mp4_too_small", size };
  return { ok: true, size };
}

async function generateNarration(openai, topic, outMp3Path) {
  // TTS가 너무 짧으면 파일이 작아질 수 있어 "최소 12초" 분량을 유도하는 스크립트를 만든다.
  const prompt = `
너는 시니어 대상 유튜브 내레이션 작가다.
주제: "${topic}"
조건:
- 한국어
- 천천히 읽었을 때 약 12초 정도 길이
- 과장 금지, 결론형 문장
출력: 내레이션 문장만 (따옴표/번호 없이)
`.trim();

  const r = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt
  });

  // responses API 텍스트 추출(안전하게)
  const text = (r.output_text || "").trim();
  if (!text) throw new Error("narration_text_empty");

  // TTS 생성 (mp3)
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    format: "mp3",
    input: text
  });

  const buf = Buffer.from(await speech.arrayBuffer());
  await fs.promises.writeFile(outMp3Path, buf);
  const size = await fileSize(outMp3Path);
  if (size < 5 * 1024) throw new Error("tts_mp3_too_small");
  return { text, mp3Path: outMp3Path, mp3Size: size };
}

async function fallbackSineAudio(outMp3Path) {
  // OpenAI TTS가 막히면(쿼터/키/네트워크) 파이프라인 확인용으로 강제 오디오를 만든다.
  // 이 fallback 덕분에 “영상 파이프라인 자체”는 항상 검증 가능.
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=440:duration=12",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    outMp3Path
  ];
  const r = await run("ffmpeg", args);
  if (r.code !== 0) {
    throw new Error(`fallback_sine_failed: ${r.stderr.slice(-4000)}`);
  }
  return { text: "(fallback sine)", mp3Path: outMp3Path, mp3Size: await fileSize(outMp3Path) };
}

async function renderMp4WithFfmpeg(audioMp3Path, outMp4Path) {
  // 12초 검정 화면 + 오디오
  // -t 12 강제 → 항상 충분한 용량
  // +faststart → 다운로드 후 바로 재생
  const args = [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=1280x720:r=30:d=12",
    "-i", audioMp3Path,
    "-vf", "format=yuv420p",
    "-af", "apad=pad_dur=12",
    "-t", "12",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "28",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    outMp4Path
  ];

  const r = await run("ffmpeg", args);
  if (r.code !== 0) {
    throw new Error(`ffmpeg_failed: ${r.stderr.slice(-4000)}`);
  }
  return r;
}

async function makeMp4({ topic, apiKey }) {
  const tmpDir = "/tmp/finishflow";
  await ensureDir(tmpDir);

  const audioMp3Path = path.join(tmpDir, "audio.mp3");
  const outMp4Path = path.join(tmpDir, "final.mp4");

  // clean old files
  try { if (fs.existsSync(audioMp3Path)) fs.unlinkSync(audioMp3Path); } catch (_) {}
  try { if (fs.existsSync(outMp4Path)) fs.unlinkSync(outMp4Path); } catch (_) {}

  const openai = new OpenAI({ apiKey });

  let narration;
  let usedFallback = false;

  try {
    narration = await generateNarration(openai, topic, audioMp3Path);
  } catch (e) {
    usedFallback = true;
    narration = await fallbackSineAudio(audioMp3Path);
  }

  // ffmpeg로 mp4 생성
  let ff;
  try {
    ff = await renderMp4WithFfmpeg(audioMp3Path, outMp4Path);
  } catch (e) {
    return {
      ok: false,
      reason: "ffmpeg_render_error",
      topic,
      usedFallback,
      error: String(e.message || e),
      debug: String(e && e.stack ? e.stack : "")
    };
  }

  // mp4 검증(빈 파일 방지 핵심)
  const v = await validateMp4(outMp4Path);
  if (!v.ok) {
    return {
      ok: false,
      reason: v.reason,
      topic,
      usedFallback,
      mp4_size: v.size || null,
      hint: "MP4가 너무 작거나 비어있습니다. ffmpeg 출력/오디오 생성 상태를 확인하세요."
    };
  }

  return {
    ok: true,
    step: 4,
    topic,
    usedFallback,
    narration_preview: narration.text.slice(0, 80),
    audio_path: audioMp3Path,
    video_path: outMp4Path,
    mp4_size: v.size
  };
}

module.exports = { makeMp4 };
