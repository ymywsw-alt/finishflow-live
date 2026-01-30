import fs from "fs";
import { execFile } from "child_process";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || "").toString();
        reject(new Error(msg || err.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function makeVideo({ topic }) {
  // step 1: TTS 생성 → /tmp/audio.mp3
  const audioPath = "/tmp/audio.mp3";
  const videoPath = "/tmp/final.mp4";

  // 기존 파일 삭제 (있으면)
  try { fs.unlinkSync(audioPath); } catch {}
  try { fs.unlinkSync(videoPath); } catch {}

  // ✅ TTS (OpenAI)
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    format: "mp3",
    input: topic
  });

  const audioBuffer = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(audioPath, audioBuffer);

  // step 2~4: ffmpeg로 단색 배경 + 오디오 → mp4 생성
  // - 자막/폰트 문제를 원천 제거하기 위해 "텍스트 오버레이 없음" (가장 안정)
  // - 오디오는 aac로 변환, -shortest로 오디오 길이에 맞춰 자동 종료
  //
  // 영상 해상도/프레임: 1280x720 / 30fps
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=1280x720:r=30",
    "-i", audioPath,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    videoPath
  ]);

  return {
    step: 4,
    topic,
    audio_generated: true,
    video_generated: true,
    video_path: videoPath
  };
}
