import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn, execSync } from "node:child_process";

function safeJson(x) {
  try { return JSON.parse(x); } catch { return null; }
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

  while (urls.length < 8) {
    urls.push(...unsplashFallbackUrls(query, 1));
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
  const d = await openaiJSON("https://api.openai.com/v1/responses", {
    model: "gpt-4.1-mini",
    max_output_tokens: 900,
    input: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userText },
    ],
  });

  const out =
    (d.output_text || "").trim() ||
    (d.output?.[0]?.content?.find((c) => c.type === "output_text")?.text || "").trim();

  return out;
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
    `Write a Korean voiceover script.\n` +
    `Return JSON only in schema {"script":"..."}.\n` +
    `No markdown.`;

  const raw = await callResponses(userText);

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = { script: raw }; }

  const script = typeof parsed?.script === "string" ? parsed.script.trim() : String(raw || "").trim();
  if (!script) throw new Error("Empty script from OpenAI");

  return {
    ok: true,
    parsed: {
      script,
      video_path: null,
      tts_path: null,
      id: crypto.randomBytes(6).toString("hex"),
      durationSec,
      videoType,
      topicTone,
      topic,
    },
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

  fs.writeFileSync(outMp3Path, audioBuf);
  return outMp3Path;
}

// ----------- VIDEO (slideshow, deterministic) -----------
async function makeVideo({ id, ttsPath, outDir, durationSec, topic }) {
  must(id, "id");
  must(ttsPath, "ttsPath");
  must(outDir, "outDir");

  ensureDir(outDir);

  // 8장 고정
  const query = (topic || "시니어 건강 정보").toString().slice(0, 80);
  const imageUrls = await collectImageUrls(query);

  const imageDir = path.join(os.tmpdir(), `finishflow-images-${id}`);
  fs.mkdirSync(imageDir, { recursive: true });

  const imagePaths = [];
  for (let i = 0; i < 8; i++) {
    const p = path.join(imageDir, `img${i}.jpg`);
    await downloadToFile(imageUrls[i], p);
    imagePaths.push(p);
  }

  // 10~12분 목표: 기본 80초(=10분40초)
  // durationSec를 넘겨받으면 그걸 우선 사용해도 되지만,
  // 현재 기준선은 10~12분 고정이므로 80초로 고정 운영.
  const perImageSec = 80;

  const slideVideoPath = path.join(os.tmpdir(), `finishflow-${id}-slides.mp4`);
  const outMp4Path = path.join(outDir, `${id}.mp4`);

  // (1) 슬라이드 영상(무음) 생성
  const inputs = imagePaths.map(p => `-loop 1 -t ${perImageSec} -i "${p}"`).join(" ");
  const slideCmd =
    `ffmpeg -y ${inputs} ` +
    `-filter_complex "concat=n=8:v=1:a=0,format=yuv420p" ` +
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
  const t0 = Date.now();
  try {
    const req = JSON.parse(fs.readFileSync("req.json", "utf-8"));

    const r = await safeMakeScript(req);
    const { id, script, durationSec } = r.parsed;

    const outDir = path.resolve(process.cwd(), "out", id);
    ensureDir(outDir);
// bg.jpg를 작업 폴더로 복사
const bgSrc = path.resolve(process.cwd(), "bg.jpg");
const bgDst = path.join(outDir, "bg.jpg");
if (!fs.existsSync(bgSrc)) throw new Error(`bg.jpg missing at ${bgSrc}`);
fs.copyFileSync(bgSrc, bgDst);

    const ttsPath = await generateTTSMp3({ id, script, outDir });
    log("ttsPath:", ttsPath);

    const videoPath = await makeVideo({ id, ttsPath, outDir, durationSec });
    log("videoPath:", videoPath);

    r.parsed.tts_path = ttsPath;
    r.parsed.video_path = videoPath;

    // stdout 단 1회
    out({
      ok: true,
      parsed: r.parsed,
      download_url: null,
      ms: Date.now() - t0
    });

  } catch (e) {
    const info = briefErr(e);
    log("FAIL:", info);

    // stdout 단 1회
    out({
      ok: false,
      error: info,
      ms: Date.now() - t0
    });

    process.exitCode = 1;
  }
})();

