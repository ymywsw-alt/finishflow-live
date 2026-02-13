import { pickStyle, getWeights } from "./lib/titleBandit.js";
import { buildTitlePrompt } from "./lib/titlePrompt.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn, execSync } from "node:child_process";

function safeJson(x) {
  try { return JSON.parse(x); } catch { return null; }
}
async function makeTitle(topic) {
  const style = pickStyle();
  const { SYSTEM, USER } = buildTitlePrompt(topic, style);

  const raw = await callResponses(`${SYSTEM}\n\n${USER}`);

  const candidates = String(raw || "")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 5);

  const chosenTitle = (candidates[0] || topic).trim();

  console.log("TITLE_STYLE:", style);
  console.log("TITLE_CANDIDATES:", candidates);
  console.log("TITLE_CHOSEN:", chosenTitle);
  console.log("TITLE_WEIGHTS:", getWeights().normalized);

  return { style, candidates, chosenTitle };
}

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0,200)}`);
  const j = safeJson(t);
  if (!j) throw new Error(`JSON parse failed: ${t.slice(0,200)}`);
  return j;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function downloadToFile(url, outPath) {
  const tries = [0, 800, 2000, 4000];
  let lastErr = null;

  for (let i = 0; i < tries.length; i++) {
    if (tries[i]) await sleep(tries[i]);

    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (FinishFlowBot/1.0)"
        }
      });

      if (!r.ok) {
        throw new Error(`download failed ${r.status}: ${url}`);
      }

      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(outPath, buf);
      return;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr;
}

function unsplashFallbackUrls(query, n) {
  return Array.from({ length: n }, (_, i) =>
    `https://source.unsplash.com/1600x900/?${encodeURIComponent(query)}&sig=${Date.now()}_${i}`
  );
}

async function getPexelsUrls(query, n, key) {
  if (!key || key === "temp") return [];
  const j = await fetchJson(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${Math.min(80, n*3)}`,
    { Authorization: key }
  );
  const photos = Array.isArray(j.photos) ? j.photos : [];
  return photos
    .map(p => p?.src?.landscape || p?.src?.large || p?.src?.original)
    .filter(Boolean)
    .slice(0, n);
}

async function getPixabayUrls(query, n, key) {
  if (!key || key === "temp") return [];
  const j = await fetchJson(
    `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=${Math.min(200, n*3)}&safesearch=true`
  );
  const hits = Array.isArray(j.hits) ? j.hits : [];
  return hits
    .map(h => h?.largeImageURL || h?.webformatURL)
    .filter(Boolean)
    .slice(0, n);
}

async function collectImageUrls(query) {
  const pexelsKey = process.env.PEXELS_API_KEY || "";
  const pixabayKey = process.env.PIXABAY_API_KEY || "";

  const pex = await getPexelsUrls(query, 3, pexelsKey).catch(() => []);
  const pix = await getPixabayUrls(query, 8, pixabayKey).catch(() => []);
  const uns = [];

  const urls = [...pex, ...pix, ...uns].filter(Boolean);

  // 키가 없어서 urls가 0이면, 여기서 명확하게 멈춰야 함(Unsplash로 안 감)
if (urls.length === 0) {
  throw new Error("No image sources available. Set PIXABAY_API_KEY (recommended) or PEXELS_API_KEY.");
}

// 부족하면 기존 urls를 반복해서 8장 채움(네트워크 추가 호출 없음)
while (urls.length < 8) {
  urls.push(urls[urls.length % Math.max(1, urls.length)]);
}

return urls.slice(0, 8);
}

// === STDOUT HARD LOCK: allow stdout ONLY via out() ===
const __stdoutWrite = process.stdout.write.bind(process.stdout);
globalThis.__ALLOW_STDOUT__ = false;

process.stdout.write = (chunk, encoding, cb) => {
  if (!globalThis.__ALLOW_STDOUT__) return true;
  return __stdoutWrite(chunk, encoding, cb);
};

// redirect console.log to stderr
console.log = (...a) => console.error("[make]", ...a);

// logs to stderr
function log(...a) { console.error("[make]", ...a); }

// only out() can write to stdout
function out(obj) {
  globalThis.__ALLOW_STDOUT__ = true;
  __stdoutWrite(JSON.stringify(obj) + "\n");
  globalThis.__ALLOW_STDOUT__ = false;
}

const SYSTEM = "Return JSON only.";

// ---------- helpers ----------
function must(v, name) {
  if (!v) throw new Error(`Missing required: ${name}`);
  return v;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function briefErr(e) {
  return {
    message: e?.message || String(e),
    name: e?.name,
    stack: (e?.stack || "").split("\n").slice(0, 10).join("\n"),
    code: e?.code,
    status: e?.status,
    cmd: e?.cmd,
    args: e?.args,
    stdout: e?.stdout,
    stderr: e?.stderr,
  };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false, ...opts });

    let stdout = "";
    let stderr = "";

    p.stdout?.on("data", (d) => (stdout += d.toString()));
    p.stderr?.on("data", (d) => (stderr += d.toString()));

    p.on("error", (e) =>
      reject(Object.assign(e, { cmd, args, stdout, stderr }))
    );

    p.on("close", (code) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      const err = new Error(`Command failed (code=${code}): ${cmd} ${args.join(" ")}`);
      err.code = code;
      err.cmd = cmd;
      err.args = args;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

// ---------- OpenAI wrappers ----------
async function openaiJSON(url, payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(`OpenAI error ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json ?? {};
}

async function openaiBinary(url, payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    const msg = json?.error?.message || text || `HTTP ${res.status}`;
    const err = new Error(`OpenAI error ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }

  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- LLM script ----------
async function callResponses(userText) {
  const MIN_SCRIPT_CHARS = 6000;
  const MAX_TRIES = 6;
  
let lastLen = 0;
let lastPromptLen = 0;
let lastPromptHead = "";

  for (let i = 1; i <= MAX_TRIES; i++) {
    const hardSpec = `
    
[절대 규칙]
[HARD SPEC — MUST FOLLOW]

당신의 목표는 “시니어(50~70대) 대상 한국어 내레이션 대본”을 생성하는 것이다.
결과물은 반드시 아래 조건을 모두 충족해야 한다. 하나라도 위반하면 실패다.

1) 절대 길이 조건
- 최종 대본은 반드시 한국어 기준 "글자 수 6000자 이상"이어야 한다.
- 6000자 미만이면 즉시 같은 출력 안에서 스스로 '추가 확장'을 수행해 6000자 이상이 될 때까지 이어서 작성한다.
- 중간에 결론을 내리지 말고, 길이 조건을 충족하기 전까지는 절대 마무리 문장(정리/마무리/결론)을 쓰지 마라.

2) 구조 조건 (블록/표식 고정)
대본은 아래 10개 블록을 "반드시 이 순서로" 포함한다. 각 블록은 표식을 그대로 사용한다.

[01_HOOK] (최소 900자)
- 시작 10초는 강한 후킹 2문장(짧고 강하게) + 바로 오늘 주제의 ‘핵심 이득’을 선언.
- 시니어의 불안/걱정(건강/돈/가족/시간) 중 하나를 "과장 없이" 건드린다.

[02_TODAY_PROMISE] (최소 500자)
- 오늘 영상에서 얻는 결과 3가지(“알게 되는 것/피하게 되는 것/바로 할 행동”)를 명확히 제시.

[03_COMMON_MISTAKE] (최소 700자)
- 사람들이 흔히 하는 실수 3가지(각 2~3문장).
- “왜 위험한지/왜 돈·시간 낭비인지”를 사례로 설명.

[04_CORE_EXPLANATION] (최소 1800자)
- 핵심 내용을 초등학생도 이해할 수준으로 단계적으로 설명.
- 어려운 용어가 나오면 즉시 쉬운 말로 다시 설명.
- 최소 4개의 소제목(예: ①,②,③,④)으로 나눈다.

[05_EXAMPLE_STORY_1] (최소 700자)
- 실제 상담/경험담처럼 들리는 구체 사례 1개.
- ‘상황→실수→손해/후회→전환점→개선’ 흐름.

[06_EXAMPLE_STORY_2] (최소 700자)
- 다른 유형의 사례 1개(성별/상황 다르게).

[07_CHECKLIST] (최소 800자)
- 시니어가 오늘 바로 점검할 체크리스트 7~10개(각 1~2문장, 이유 포함).

[08_ACTION_PLAN] (최소 900자)
- 오늘/이번주/한달 플랜으로 나눠 실행 행동을 제시.
- 각 단계는 “시간(몇 분) / 준비물 / 실패 방지 팁”을 포함.

[09_FAQ] (최소 700자)
- 시니어가 진짜로 물어볼 질문 6개 + 답변(각 2~4문장).

[10_WRAP] (최소 300자, 단 6000자 달성 이후에만)
- 오늘 핵심 1문장 요약 + 부담 없는 마무리(구독/좋아요 같은 말은 넣지 말 것).

3) 리텐션(이탈 방지) 규칙 — 3회 강제 삽입
- 아래 문장을 내용에 자연스럽게 섞어 “총 3번” 넣어라(똑같이 복붙 금지, 의미만 유지).
  a) “잠깐만요, 여기서 많은 분들이 한 가지를 놓칩니다.”
  b) “지금부터가 핵심입니다. 끝까지 보셔야 손해를 막습니다.”
  c) “마지막에 ‘바로 실행하는 1가지’를 정리해 드립니다.”

4) 문체/톤 규칙
- 중년·시니어 친화적, 과장 없이 단정하고 따뜻한 말투.
- 한 문장은 너무 길지 않게(대부분 20~35자 내외), 호흡감 있게.
- ‘전문가 흉내’ 금지: 근거 없는 단정, 공포 조장, 과장 광고 같은 문장 금지.

5) 금지 규칙 (중요)
- “저는 AI입니다”, “모델”, “토큰”, “출력” 등 메타 발언 금지.
- “요약하면/결론적으로/마무리하겠습니다”를 6000자 달성 전에 쓰지 마라.
- 글자 수를 직접 세거나 숫자를 출력하지 마라. (예: “지금 6,500자입니다” 금지)
- 리스트만 잔뜩 나열하고 설명 없이 끝내지 마라.

6) 실패 방지: 자기확장(EXTEND) 프로토콜
- 작성 도중 분량이 부족할 것 같으면, 즉시 아래 방식으로 확장한다:
  - [04_CORE_EXPLANATION]에 소제목을 1~2개 추가하고 설명을 더한다.
  - [05]/[06] 사례의 대화/상황 묘사를 더 구체화한다.
  - [07_CHECKLIST] 항목을 2~3개 추가하고 이유를 더한다.
  - [09_FAQ] 질문을 1~2개 더 추가한다.
- 어떤 확장을 하든, 최종 결과는 반드시 6000자 이상이어야 한다.

[END HARD SPEC]
`;

    const retryNudge =
      i === 1
        ? ""
        : `\n\n[재작성]\n이전 대본이 너무 짧았습니다. 반드시 ${MIN_SCRIPT_CHARS}자 이상으로 더 길고 구체적으로 다시 작성하세요.\n`;

    const prompt = userText + retryNudge + hardSpec;
    
    lastPromptLen = prompt.length;
lastPromptHead = prompt.slice(0, 200).replace(/\s+/g, " ");
console.log("PROMPT_LEN:", lastPromptLen);
console.log("PROMPT_HEAD:", lastPromptHead);

    console.log("PROMPT LEN:", lastPromptLen, "TRY:", i);

const d = await openaiJSON("https://api.openai.com/v1/responses", {
  model: "gpt-4.1-mini",
  max_output_tokens: 16000,
  input: [
    { role: "system", content: SYSTEM },
    { role: "user", content: prompt },
  ],
});
    
console.log("RESP_KEYS:", Object.keys(d || {}));
console.log("RESP_SNIP:", JSON.stringify(d).slice(0, 1200));
   
console.log("RESP_KEYS:", Object.keys(d || {}));
console.log("RESP_SNIP:", JSON.stringify(d).slice(0, 800));

    const pickText = (obj) => {
  if (typeof obj?.output_text === "string" && obj.output_text.trim()) return obj.output_text.trim();

  const c1 = obj?.output?.[0]?.content;
  if (Array.isArray(c1)) {
    const t = c1.find(x => x?.type === "output_text");
    if (t && typeof t.text === "string" && t.text.trim()) return t.text.trim();

    for (const x of c1) {
      if (typeof x?.text === "string" && x.text.trim()) return x.text.trim();
      if (typeof x?.content === "string" && x.content.trim()) return x.content.trim();
      if (Array.isArray(x?.content)) {
        for (const y of x.content) {
          if (typeof y?.text === "string" && y.text.trim()) return y.text.trim();
        }
      }
    }
  }

  const m = obj?.choices?.[0]?.message?.content;
  if (typeof m === "string" && m.trim()) return m.trim();

  return JSON.stringify(obj).slice(0, 2000);
};
const text = pickText(d);
console.log("TEXT PICKED LEN:", text.length);

const isJsonFallback = text.trim().startsWith("{") || text.trim().startsWith("[");
console.log("TEXT_IS_JSON_FALLBACK:", isJsonFallback);
console.log("TEXT_HEAD:", text.slice(0, 180).replace(/\s+/g, " "));

console.log("SCRIPT LENGTH:", text.length);
lastLen = text.length;

    console.log("SCRIPT LENGTH:", text.length);
lastLen = text.length;

    if (text.length >= MIN_SCRIPT_CHARS) {
      return text;
    }

const preview = String(text || "").slice(0, 400);

throw new Error(
  `Failed to generate sufficiently long script (lastLen=${lastLen}, min=${MIN_SCRIPT_CHARS}, promptLen=${lastPromptLen}) preview=${JSON.stringify(preview)}`
);
}

async function safeMakeScript(req) {
  const topic = typeof req.topic === "string" ? req.topic.trim() : "";
  const videoType = typeof req.videoType === "string" ? req.videoType : "SHORT";
  const topicTone = typeof req.topicTone === "string" ? req.topicTone : "CALM";
  const durationSec =
    typeof req.durationSec === "number" && Number.isFinite(req.durationSec) ? req.durationSec : 45;

  if (!topic) throw new Error("Missing topic");

  const userText =
`topic: ${topic}\n` +
`type: ${videoType}\n` +
`tone: ${topicTone}\n` +
`seconds: ${durationSec}\n` +
`Write a LONG and detailed Korean voiceover script.\n` +
`Minimum length: 6000 Korean characters.\n` +
`The script must take 10-12 minutes when read aloud.\n` +
`Structure the script with:\n` +
`1. Opening hook\n` +
`2. Explanation\n` +
`3. Practical tips\n` +
`4. Closing summary\n` +
`Do not shorten the content.\n` +
`Return JSON only in schema {"script":"..."}.\n` +
`No markdown.`;
  
const t = await makeTitle(topic);
const title = t.chosenTitle;
  
  const prefix = `제목: ${title}\n이 제목에 맞는 시니어 대상 스크립트를 작성한다.\n\n`;
const raw = await callResponses(prefix + userText);

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = { script: raw }; }

  const script = typeof parsed?.script === "string" ? parsed.script : "";
console.log("SCRIPT LENGTH:", script.length);

  const MIN_SCRIPT_CHARS = 6000;
if (script.length < MIN_SCRIPT_CHARS) {
  throw new Error(`Script too short: ${script.length} (min ${MIN_SCRIPT_CHARS})`);
}
if (!script) throw new Error("Empty script from OpenAI");

  return {
    ok: true,
    parsed: {
  id: crypto.randomBytes(6).toString("hex"),
  title,
  titleStyle: t.style,
  titleCandidates: t.candidates,
  script,
},
video_path: null,
tts_path: null,
      durationSec,
      videoType,
      topicTone,
      topic,
    download_url: null,
  };
}

// ---------- TTS ----------
async function generateTTSMp3({ id, script, outDir }) {
  must(id, "id");
  must(script, "script");
  must(outDir, "outDir");

  ensureDir(outDir);

  const outMp3Path = path.join(outDir, `${id}.mp3`);

  // TTS (Audio API /v1/audio/speech)
  const audioBuf = await openaiBinary("https://api.openai.com/v1/audio/speech", {
  model: "gpt-4o-mini-tts",
  voice: "alloy",
  format: "mp3",
  input: script,
});

console.log("TTS BYTES:", audioBuf?.length || 0);

fs.writeFileSync(outMp3Path, audioBuf);

console.log("AUDIO FILE CREATED:", outMp3Path);

return outMp3Path;

}

// ----------- VIDEO (slideshow, deterministic) -----------
async function makeVideo({ id, ttsPath, outDir, durationSec, topic }) {
  must(id, "id");
  must(ttsPath, "ttsPath");
  must(outDir, "outDir");
  
const t = await makeTitle(topic);
const title = t.chosenTitle;

  ensureDir(outDir);

  // 8장 고정
  const query = (topic || "시니어 건강 정보").toString().slice(0, 80);
  const imageUrls = await collectImageUrls(query);

  const imageDir = path.join(os.tmpdir(), `finishflow-images-${id}`);
  fs.mkdirSync(imageDir, { recursive: true });

const TARGET_IMAGES = 40;
const perImageSec = Math.max(6, Math.floor((durationSec || 600) / TARGET_IMAGES));

  const imagePaths = [];

if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
  throw new Error("No image URLs collected");
}

for (let i = 0; i < TARGET_IMAGES; i++) {
  const url = imageUrls[i % imageUrls.length]; // 부족하면 반복 사용
  const p = path.join(imageDir, `img${i}.jpg`);
  await downloadToFile(url, p);
  if (fs.statSync(p).size < 10_000) throw new Error(`image too small (likely invalid): ${p}`);
  imagePaths.push(p);
}

  // 10~12분 목표: 기본 80초(=10분40초)
  // durationSec를 넘겨받으면 그걸 우선 사용해도 되지만,
  // 현재 기준선은 10~12분 고정이므로 80초로 고정 운영.
  
  const slideVideoPath = path.join(os.tmpdir(), `finishflow-${id}-slides.mp4`);
  const outMp4Path = path.join(outDir, `${id}.mp4`);

  // (1) 슬라이드 영상(무음) 생성
  // concat demuxer용 리스트 파일 생성
const listPath = path.join(os.tmpdir(), `finishflow-${id}-list.txt`);
const lines = [];
for (const p of imagePaths) {
  // 각 이미지 파일을 perImageSec 초 동안 보여줌
  lines.push(`file '${p.replace(/'/g, "'\\''")}'`);
  lines.push(`duration ${perImageSec}`);
}
// 마지막 file은 duration이 무시될 수 있어 한번 더 넣어줌(권장)
lines.push(`file '${imagePaths[imagePaths.length - 1].replace(/'/g, "'\\''")}'`);

fs.writeFileSync(listPath, lines.join("\n"), "utf8");

// 슬라이드 영상 생성(무음)
const slideCmd =
  `ffmpeg -y -f concat -safe 0 -i "${listPath}" ` +
  `-vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p" ` +
  `-r 30 "${slideVideoPath}"`;

execSync(slideCmd, { stdio: "inherit" });

  // (2) 슬라이드 + TTS 합성 (최종 mp4)
  const finalCmd =
    `ffmpeg -y -i "${slideVideoPath}" -i "${ttsPath}" ` +
    `-c:v copy -c:a aac -shortest "${outMp4Path}"`;

  execSync(finalCmd, { stdio: "inherit" });

  return outMp4Path;
}

// ---------- entry ----------
(async () => {
  try {
    const req = JSON.parse(fs.readFileSync("req.json", "utf-8"));

    const r = await safeMakeScript(req);
    const { id, script, durationSec } = r.parsed;

    const outDir = path.resolve(process.cwd(), "out", id);
    ensureDir(outDir);

    // bg-jpg를 쓰는 경우만 유지(없으면 이 블록은 네 기존 로직에 맞춰 조정)
    const bgJpg = path.resolve(process.cwd(), "bg-jpg");
    if (!fs.existsSync(bgJpg)) throw new Error(`bg-jpg missing at ${bgJpg}`);

    const bgSrc = path.resolve(process.cwd(), "bg-jpg");
    const bgDst = path.join(outDir, "bg-jpg");
    fs.copyFileSync(bgSrc, bgDst);

    const ttsPath = await generateTTSMp3({ id, script, outDir });
    log("ttsPath:", ttsPath);

    const videoPath = await makeVideo({ id, ttsPath, outDir, durationSec });
    log("videoPath:", videoPath);

    r.parsed.tts_path = ttsPath;
    r.parsed.video_path = videoPath;

    // stdout 반환
    out({
      ok: true,
      parsed: r.parsed,
      download_url: `/download?token=${id}`,
      ms: Date.now() - t0,
    });
  } catch (e) {
    const info = briefErr(e);
    log("FAIL:", info);

    out({
      ok: false,
      error: info,
      ms: Date.now() - t0,
    });

    process.exitCode = 1;
  }
})();