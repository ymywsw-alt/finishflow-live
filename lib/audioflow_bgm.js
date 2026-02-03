// lib/audioflow_bgm.js  (CommonJS)
// 목적: AudioFlow /make 호출 → download_url 받아오기(지금 단계는 '연동 토대'만)

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const AUDIOFLOW_ENGINE_URL =
  process.env.AUDIOFLOW_ENGINE_URL || "https://audioflow-live.onrender.com";

const AUDIOFLOW_TIMEOUT_MS = Number(process.env.AUDIOFLOW_TIMEOUT_MS || 120000);

function mapPresetForFinishFlow(kind = "default") {
  if (kind === "shorts") return "UPBEAT_SHORTS";
  if (kind === "documentary") return "DOCUMENTARY";
  return "CALM_LOOP";
}

function tmpFile(ext) {
  const id = crypto.randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `audioflow_${Date.now()}_${id}.${ext}`);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), AUDIOFLOW_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function downloadToFile(url, outPath) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`DL_HTTP_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/**
 * AudioFlow로 BGM 생성 후 wav 파일로 다운로드
 * @returns {Promise<{ wavPath: string, meta: any, preset: string, durationSec: number }>}
 */
async function createBgmWav({ topic, kind = "default", preset, durationSec = 90 }) {
  const finalPreset = preset || mapPresetForFinishFlow(kind);

  const res = await fetchWithTimeout(`${AUDIOFLOW_ENGINE_URL}/make`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      preset: finalPreset,
      duration_sec: durationSec,
    }),
  });

  if (res.status === 429) throw new Error("AUDIOFLOW_RATE_LIMIT");

  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) {
    const code = j?.code || `HTTP_${res.status}`;
    throw new Error(`AUDIOFLOW_FAIL_${code}`);
  }

  const dlPath = j?.data?.audio?.download_url;
  if (!dlPath) throw new Error("AUDIOFLOW_NO_DOWNLOAD_URL");

  const wavUrl = `${AUDIOFLOW_ENGINE_URL}${dlPath}`;
  const wavPath = tmpFile("wav");
  await downloadToFile(wavUrl, wavPath);

  return { wavPath, meta: j.data, preset: finalPreset, durationSec };
}

module.exports = {
  createBgmWav,
  mapPresetForFinishFlow,
};
