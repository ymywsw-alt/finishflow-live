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

export async function make(topic) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const script = `오늘의 주제입니다.\n${topic}\n차분하고 명확하게 설명합니다.`;

  const outDir = "/tmp";
  const audioPath = path.join(outDir, "voice.mp3");
  const videoPath = path.join(outDir, "final.mp4");

  // 1) TTS -> mp3
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: script
  });

  const buffer = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(audioPath, buffer);

  // 2) mp3 -> mp4 (solid background + audio)
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
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-pix_fmt",
    "yuv420p",
    videoPath
  ]);

  return {
    ok: true,
    step: 4,
    topic,
    audio_generated: true,
    video_generated: true
  };
}
