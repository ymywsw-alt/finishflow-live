import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const AUDIOFLOW_ENGINE_URL = process.env.AUDIOFLOW_ENGINE_URL || "https://audioflow-live.onrender.com";
const AUDIOFLOW_TIMEOUT_MS = Number(process.env.AUDIOFLOW_TIMEOUT_MS || 120000);

// 프리셋 매핑(고정 규칙)
export function mapPresetForFinishFlow({ kind }) {
  // kind 예시: "longform" | "shorts" | "documentary" | "default"
  if (kind === "shorts") return "UPBEAT_SHORTS";
  if (kind === "documentary") return "DOCUMENTARY";
  return "CALM_LOOP";
}

// 안전한 tmp 파일 경로
function tmpFile(ext) {
  const id = crypto.randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `audioflow_${Date.now()}_${id}.${ext}`);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), AUDIOFLOW_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
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
 * @returns {Promise<{wavPath: string, meta: any}>}
 */
export async function createBgmWav({ topic, preset, durationSec }) {
  const res = await fetchWithTimeout(`${AUDIOFLOW_ENGINE_URL}/make`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      preset,
      duration_sec: durationSec,
    }),
  });

  // 레이트리밋이면 명확히 에러
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

  return { wavPath, meta: j.data };
}

/**
 * ffmpeg로 videoPath에 bgm 삽입(기본: 원본 오디오가 있으면 믹스, 없으면 bgm만)
 * @returns {Promise<string>} outputVideoPath
 */
export async function attachBgmToVideo({ videoPath, bgmWavPath, bgmVolume = 0.22 }) {
  const outPath = tmpFile("mp4");

  // 핵심: 원본 오디오가 있을 때는 amix, 없을 때도 동작하도록 가장 안전한 형태
  // -shortest: 영상 길이에 맞춤
  // -c:v copy: 영상 재인코딩 최소
  // -c:a aac: 오디오는 표준 aac로
  const filter = `[1:a]volume=${bgmVolume}[bgm];` +
                 `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`;

  // 일부 영상은 0:a(오디오 트랙) 자체가 없을 수 있음 → 그 경우엔 아래 fallback 실행
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-i", bgmWavPath,
      "-filter_complex", filter,
      "-map", "0:v:0",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      outPath
    ]);
    return outPath;
  } catch (e) {
    // fallback: 원본 오디오 없는 경우 -> bgm만 넣기
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-i", bgmWavPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      outPath
    ]);
    return outPath;
  }
}

/**
 * 편의 함수: topic 기반으로 생성→삽입까지 한 번에
 */
export async function generateAndAttachBgm({ topic, kind = "default", durationSec = 90, videoPath }) {
  const preset = mapPresetForFinishFlow({ kind });
  const { wavPath } = await createBgmWav({ topic, preset, durationSec });

  try {
    const outVideo = await attachBgmToVideo({ videoPath, bgmWavPath: wavPath });
    return outVideo;
  } finally {
    // tmp wav 정리(실패해도 서비스 영향 없음)
    try { fs.unlinkSync(wavPath); } catch {}
  }
}
