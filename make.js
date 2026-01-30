import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * make(topic)
 * - OpenAI TTS로 mp3 생성
 * - ffmpeg로 단색 배경 mp4 생성(음성 포함)
 * - /tmp/final.mp4 생성
 */
export async function make(topic) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const t = String(topic || "").trim();
  if (!t) throw new Error("topic required");

  // ✅ 과도한 길이 방지(안정성)
  const safeTopic = t.slice(0, 120);

  // 음성 스크립트(단정/명확)
  const script = `오늘의 주제입니다. ${safeTopic}.
핵심만 정리해 드립니다.
첫째, 무엇인지.
둘째, 왜 중요한지.
셋째, 오늘 바로 할 수 있는 행동 하나.`;

  const outDir = "/tmp";
  const audioPath = path.join(outDir, "voice.mp3");
  const videoPath = path.join(outDir, "final.mp4");

  // 1) TTS -> mp3
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: script,
  });

  const buffer = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(audioPath, buffer);

  // 2) mp3 -> mp4 (검정 배경 + 오디오)
  // -shortest: 오디오 길이에 맞춰 종료
  await run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=1280x720:r=30",
    "-i",
    audioPath,
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "stillimage",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    videoPath,
  ]);

  // 결과는 server.js가 다운로드로 제공
  return {
    ok: true,
    step: 4,
    topic: safeTopic,
    audio_generated: true,
    video_generated: true,
    video_path: "/tmp/final.mp4",
  };
}
