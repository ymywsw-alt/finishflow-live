import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function make(topic) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const script = `오늘의 주제입니다.\n${topic}\n차분하고 명확하게 설명합니다.`;

  const outDir = "/tmp";
  const audioPath = path.join(outDir, "voice.mp3");

  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: script
  });

  const buffer = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(audioPath, buffer);

  return {
    step: 3,
    topic,
    audio_generated: true
  };
}
