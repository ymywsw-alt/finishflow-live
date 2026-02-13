// make.js (ESM) - finishflow-live
// STDOUT must be JSON only via out(). All logs go to stderr.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";

// =========================
// stdout hard lock
// =========================
const __stdoutWrite = process.stdout.write.bind(process.stdout);
globalThis.__ALLOW_STDOUT__ = false;
process.stdout.write = (chunk, encoding, cb) => {
  if (!globalThis.__ALLOW_STDOUT__) return true;
  return __stdoutWrite(chunk, encoding, cb);
};
console.log = (...a) => console.error("[make]", ...a);
function log(...a) { console.error("[make]", ...a); }
function out(obj) {
  globalThis.__ALLOW_STDOUT__ = true;
  __stdoutWrite(JSON.stringify(obj) + "\n");
  globalThis.__ALLOW_STDOUT__ = false;
}

const t0 = Date.now();

// =========================
// helpers
// =========================
function safeJson(x) { try { return JSON.parse(x); } catch { return null; } }
function must(v, name) { if (!v) throw new Error(`Missing required: ${name}`); return v; }
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function briefErr(e) {
  return {
    message: e?.message || String(e),
    name: e?.name,
    stack: (e?.stack || "").split("\n").slice(0, 12).join("\n"),
    code: e?.code,
    cmd: e?.cmd,
  };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { shell: false, ...opts });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", d => (stdout += d.toString()));
    p.stderr?.on("data", d => (stderr += d.toString()));
    p.on("error", e => reject(Object.assign(e, { cmd, args, stdout, stderr })));
    p.on("close", code => {
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

// =========================
// OpenAI wrappers (Responses API)
// =========================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
if (!OPENAI_API_KEY) {
  // do not throw here; make() will show clear error
  log("WARN: OPENAI_API_KEY missing");
}

async function openaiJSON(url, bodyObj) {
  must(url, "url");
  must(bodyObj, "body");
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${t.slice(0, 400)}`);
  const j = safeJson(t);
  if (!j) throw new Error(`OpenAI JSON parse failed: ${t.slice(0, 400)}`);
  return j;
}

async function openaiBinary(url, bodyObj) {
  must(url, "url");
  must(bodyObj, "body");
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${t.slice(0, 400)}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// pickText for Responses API (robust)
function pickText(resp) {
  const t1 = (resp?.output_text || "").trim();
  if (t1) return t1;

  const out = resp?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const c = item?.content;
      if (Array.isArray(c)) {
        for (const cc of c) {
          if (cc?.type === "output_text" && typeof cc?.text === "string" && cc.text.trim()) return cc.text.trim();
        }
      }
    }
  }

  // fallback: stringify
  return JSON.stringify(resp);
}

async function callResponses(userText, maxTokens = 16000) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing on finishflow-live");
  const d = await openaiJSON("https://api.openai.com/v1/responses", {
    model: "gpt-4o-mini",
    max_output_tokens: maxTokens,
    input: [
      { role: "system", content: "You are a Korean voiceover script writer for seniors. Follow the HARD SPEC exactly." },
      { role: "user", content: userText },
    ],
  });
  return pickText(d);
}

// =========================
// Script generation (retry 2)
// =========================
const MIN_SCRIPT_CHARS = 6000;
const MAX_TRIES = 3;

function buildHardSpec(topic, title) {
  return `
[HARD SPEC - MUST FOLLOW]
목표: 한국 시니어(50~70대) 대상 유튜브 내레이션 대본. 주제: ${topic}. 제목: ${title}

[절대 규칙]
- 출력은 "대본 텍스트"만. 메타설명/사과/AI 언급/마크다운 금지.
- 최종 대본은 반드시 한국어 기준 글자 수 ${MIN_SCRIPT_CHARS}자 이상.
- 중간에 결론을 먼저 내지 말고, 마지막에 1~2문장 결론.
- 추상 금지: 사례/상황/숫자/체크리스트/실행 단계 포함.
- 문단은 최소 20개 이상. 각 문단 최소 3문장.
- '자막용' 짧은 문장 혼합(중간중간 1문장 강조).

[구조(순서 고정)]
1) 오프닝 훅(공감+문제 제기) 6문단
2) 핵심 설명(원리/배경) 6문단
3) 사례 3개(각 3문단 이상)
4) 체크리스트 10개(각 1~2문장)
5) 오늘 당장 할 행동 7개(각 1문장)
6) 마무리: 요약 2문단 + 결론 1~2문장

[톤]
- 중년/시니어에게 친절하고 단정한 설명
- 과장/자극적 클릭베이트 금지, 그러나 지루하지 않게 리듬감 있게
[END HARD SPEC]
`.trim();
}

async function makeTitle(topic) {
  const raw = await callResponses(
    `주제: ${topic}\n\n시니어 유튜브용 제목을 5개 후보로 제시하고, 첫 줄에 가장 좋은 1개를 출력해라.\n형식: 1줄 제목만.`,
    800
  );
  const first = String(raw || "").split("\n").map(s => s.trim()).filter(Boolean)[0] || topic;
  return first.slice(0, 60);
}

async function generateScript(topic) {
  const title = await makeTitle(topic);

  for (let i = 1; i <= MAX_TRIES; i++) {
    const retryNudge =
      i === 1
        ? ""
        : `\n[재작성]\n이전 결과가 너무 짧거나 규칙 위반이었다. ${MIN_SCRIPT_CHARS}자 이상이 될 때까지 같은 출력 안에서 확장하여 완성하라.\n`;

    const prompt =
      `주제: ${topic}\n제목: ${title}\n` +
      `요청: ${MIN_SCRIPT_CHARS}자 이상 한국어 내레이션 대본을 작성하라.\n` +
      retryNudge +
      buildHardSpec(topic, title);

    const raw = await callResponses(prompt, 16000);
    const text = String(raw || "").trim();

    log("SCRIPT_LEN:", text.length, "try=", i);

    if (text.length >= MIN_SCRIPT_CHARS) {
      return { title, script: text };
    }
  }

  throw new Error(`Failed to generate sufficiently long script (min=${MIN_SCRIPT_CHARS})`);
}

// =========================
// TTS
// =========================
async function generateTTSMp3({ id, script, outDir }) {
  must(id, "id");
  must(script, "script");
  must(outDir, "outDir");
  ensureDir(outDir);

  const outMp3Path = path.join(outDir, `${id}.mp3`);

  const audioBuf = await openaiBinary("https://api.openai.com/v1/audio/speech", {
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    format: "mp3",
    input: script,
  });

  fs.writeFileSync(outMp3Path, audioBuf);
  log("TTS_MP3:", outMp3Path, "bytes=", audioBuf?.length || 0);
  return outMp3Path;
}

// =========================
// Images (Pixabay recommended, else fail fast)
// =========================
async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
  const j = safeJson(t);
  if (!j) throw new Error(`JSON parse failed: ${t.slice(0, 200)}`);
  return j;
}

async function getPixabayUrls(query, n, key) {
  if (!key || key === "temp") return [];
  const j = await fetchJson(
    `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=${Math.min(200, n * 3)}&safesearch=true`
  );
  const hits = Array.isArray(j.hits) ? j.hits : [];
  return hits.map(h => h?.largeImageURL || h?.webformatURL).filter(Boolean).slice(0, n);
}

async function collectImageUrls(query) {
  const pixabayKey = process.env.PIXABAY_API_KEY || "";
  const urls = await getPixabayUrls(query, 40, pixabayKey).catch(() => []);

  if (!urls.length) {
    throw new Error("No image sources available. Set PIXABAY_API_KEY (recommended).");
  }

  // ensure 40
  while (urls.length < 40) urls.push(urls[urls.length % Math.max(1, urls.length)]);
  return urls.slice(0, 40);
}

async function downloadToFile(url, outPath) {
  const tries = [0, 800, 2000, 4000];
  let lastErr = null;

  for (let i = 0; i < tries.length; i++) {
    if (tries[i]) await sleep(tries[i]);
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (FinishFlowBot/1.0)" } });
      if (!r.ok) throw new Error(`download failed ${r.status}: ${url}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(outPath, buf);
      if (fs.statSync(outPath).size < 10_000) throw new Error(`image too small: ${outPath}`);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// =========================
// Video: slideshow length = audio length (sync)
// =========================
async function getMp3DurationSec(mp3Path) {
  // ffprobe output seconds
  const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${mp3Path}"`;
  const out = execSync(cmd, { encoding: "utf8" }).trim();
  const sec = Math.max(1, Math.round(Number(out) || 0));
  return sec;
}

async function makeVideo({ id, ttsPath, outDir, topic }) {
  must(id, "id");
  must(ttsPath, "ttsPath");
  must(outDir, "outDir");

  const durationSec = await getMp3DurationSec(ttsPath);
  log("AUDIO_SEC:", durationSec);

  const query = (topic || "시니어 건강 정보").toString().slice(0, 80);
  const imageUrls = await collectImageUrls(query);

  const tmpDir = path.join(os.tmpdir(), `finishflow-images-${id}`);
  ensureDir(tmpDir);

  const imagePaths = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const p = path.join(tmpDir, `img${i}.jpg`);
    await downloadToFile(imageUrls[i], p);
    imagePaths.push(p);
  }

  // distribute duration across images
  const perImageSec = Math.max(2, Math.floor(durationSec / imagePaths.length));
  const listPath = path.join(os.tmpdir(), `finishflow-${id}-list.txt`);
  const lines = [];
  for (const p of imagePaths) {
    lines.push(`file '${p.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${perImageSec}`);
  }
  lines.push(`file '${imagePaths[imagePaths.length - 1].replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join("\n"), "utf8");

  const slideVideoPath = path.join(os.tmpdir(), `finishflow-${id}-slides.mp4`);
  const outMp4Path = path.join(outDir, `${id}.mp4`);

  const slideCmd =
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" ` +
    `-vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p" ` +
    `-r 30 "${slideVideoPath}"`;

  execSync(slideCmd, { stdio: "inherit" });

  const finalCmd =
    `ffmpeg -y -i "${slideVideoPath}" -i "${ttsPath}" ` +
    `-c:v copy -c:a aac -shortest "${outMp4Path}"`;

  execSync(finalCmd, { stdio: "inherit" });

  return { outMp4Path, durationSec };
}

// =========================
// main
// =========================
async function main() {
  const req = safeJson(fs.readFileSync("req.json", "utf-8")) || {};
  const topic = typeof req.topic === "string" ? req.topic.trim() : "";
  if (!topic) throw new Error("Missing topic in req.json");

  const id = crypto.randomBytes(6).toString("hex");
  const outDir = path.resolve(process.cwd(), "out", id);
  ensureDir(outDir);

  const { title, script } = await generateScript(topic);

  const ttsPath = await generateTTSMp3({ id, script, outDir });

  const { outMp4Path, durationSec } = await makeVideo({ id, ttsPath, outDir, topic });

  return {
    ok: true,
    parsed: {
      id,
      title,
      script,
      tts_path: ttsPath,
      video_path: outMp4Path,
      durationSec,
      topic,
    },
    download_url: `/download?token=${id}`,
    ms: Date.now() - t0,
  };
}

(async () => {
  try {
    const result = await main();
    out(result);
  } catch (e) {
    const info = briefErr(e);
    log("FAIL:", info);
    out({ ok: false, error: info, ms: Date.now() - t0 });
    process.exitCode = 1;
  }
})();
