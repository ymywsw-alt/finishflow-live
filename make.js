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

  t = t.replace(/([.!?])\s*/g, "$1\n"); // 문장 끝 쉼
  t = t.replace(
    /(^|\n)\s*(하지만|그리고|그래서|특히|결론은)\s*/g,
    "$1\n$2 "
  ); // 전환어(줄 시작) 앞 쉼

  t = t.replace(/[,，]\s*/g, ", "); // 쉼표 정리

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
async function generateScript(topic, videoType = "LONG", durationSec = 720) {
  const RULES = `
[말하기용 대본 규칙 - 절대 준수]
- 문장은 말하듯이 짧게 끊어라.
- 한 문장은 최대 12단어를 넘기지 마라.
- 줄바꿈을 적극 사용하라.
- 설명은 짧은 문장 2개 + 보충 설명 1개 리듬으로 작성하라.
- 접속사(하지만/그리고/그래서/특히/결론은) 앞뒤는 반드시 끊어라.
- 강조는 쉼과 줄바꿈으로만 표현한다.
- 숫자나 단계는 반드시 줄바꿈으로 구분한다.
- 결과는 나레이션 원고만 출력한다.
`.trim();

  const longPrompt = `
당신은 시니어 대상 유튜브 나레이션 작가다.
타겟은 50~80대이며 차분하고 단정한 톤이다.

[콘텐츠 목표]
- 불안 해소
- 실용 정보 제공
- 오늘 할 행동 1개 제시

[구성]
1) 인트로 (0~1분)
   신뢰감 있는 인사 → 오늘의 결론을 한 줄로 예고 → 시니어의 고민에 공감하는 문장 2~3개

2) 본론 1 (1~4분)
   주제의 기본 원리와 핵심 정보 설명
   어려운 용어는 쉬운 말로 풀어서 설명하고, 예시를 2~3개 포함

3) 사례 구간 (4~7분)
   실제 상황 예시 3개를 이야기 형식으로 설명
   시니어가 흔히 겪는 상황 중심으로 구체적으로 묘사

4) 브릿지 (7분 지점)
   지금까지 내용을 한 문장으로 정리하고
   “이제 가장 중요한 부분을 말씀드리겠습니다.”와 같은 자연스러운 전환 문장 사용

5) 본론 2 (7~11분)
   바로 실천할 수 있는 방법을 단계별로 설명
   체크리스트 형식의 항목 5개 이상 포함

6) 결론 (11~12분)
   핵심 내용 요약
   오늘 당장 할 행동 1가지를 분명하게 제시

7) 클로징 (마지막)
   따뜻한 건강 인사
   다음 영상에서 다룰 주제를 자연스럽게 예고

전체 분량은 한국어 기준 약 8~12분 분량(최소 1,600~2,400단어)에 맞춰 충분히 자세하게 작성한다.
각 섹션마다 구체적인 사례와 설명을 포함하여 분량을 확보한다.
각 섹션은 최소 8문장 이상으로 작성한다. 절대 짧게 끝내지 마라.
전체 출력은 최소 2,200단어 이상이어야 한다. 부족하면 내용을 더 추가해서 늘려라.
마크다운 기호(**, #, [, ])는 절대 쓰지 말고, 섹션 표시는 문장으로만 말해라. (예: "인트로입니다.")
각 항목마다 실제 사례를 2개 이상 자세히 설명하라.
설명은 짧게 요약하지 말고, 말로 풀어서 천천히 설명하라.
각 핵심 내용은 예시 또는 상황 설명을 반드시 포함한다.

${RULES}

주제: ${topic}
분량: 약 ${durationSec}초 분량
`.trim();

  const shortPrompt = `
당신은 시니어 대상 숏폼 나레이션 작가다.

[구성]
- 질문 1줄
- 핵심 답 2~3줄
- 오늘 행동 1줄

${RULES}

주제: ${topic}
`.trim();

  // ✅ 핵심: prompt 스코프 복구 (prompt is not defined 방지)
  const prompt = videoType === "SHORT" ? shortPrompt : longPrompt;

  const SYSTEM =
    "You write Korean voiceover scripts that sound natural for middle-aged and older audiences.";

  async function callResponses(userText) {
    const d = await openaiJSON("https://api.openai.com/v1/responses", {
      model: "gpt-4o-mini",
      max_output_tokens: 6000,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userText }
      ]
    });

    const out =
      (d.output_text || "").trim() ||
      (d.output?.[0]?.content?.find((c) => c.type === "output_text")?.text || "")
        .trim();

    return out;
  }

  // 1) first draft
  let text = await callResponses(prompt);

  // 2) if too short, auto-extend 1~2 times
  const minCharsNoSpace = 14000; // 8~12분 목표(공백 제외) 안전 기준
  const maxExtend = 2;

  function charsNoSpace(s) {
    return (s || "").replace(/\s+/g, "").length;
  }

  for (let i = 0; i < maxExtend; i++) {
    if (charsNoSpace(text) >= minCharsNoSpace) break;

    const extendPrompt = `
지금 대본이 너무 짧습니다. 아래 대본을 "그대로 이어서" 확장하세요.
조건:
- 같은 톤(차분/단정/시니어 대상)을 유지
- 각 섹션에 구체적 사례를 2개 이상 추가
- 체크리스트/실천 단계/주의사항을 더 촘촘히 추가
- 마크다운 기호(**, #, [, ]) 금지
- 처음부터 다시 쓰지 말고, 반드시 "이어서"만 출력

[기존 대본]
${text}

[이어서 확장]
`.trim();

    const add = await callResponses(extendPrompt);
    if (!add) break;
    text = (text + "\n" + add).trim();
  }

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
    speed: 0.9,
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
