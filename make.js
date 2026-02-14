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
function clampInt(n, lo, hi, defVal) {
  const x = Number(n);
  if (!Number.isFinite(x)) return defVal;
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}
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

async function callResponses(userText, maxTokens = 4000, systemText = null) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing on finishflow-live");
  const sys = systemText || "You are a Korean content writer. Follow all constraints exactly.";
  const d = await openaiJSON("https://api.openai.com/v1/responses", {
    model: "gpt-4o-mini",
    max_output_tokens: maxTokens,
    input: [
      { role: "system", content: sys },
      { role: "user", content: userText },
    ],
  });
  return pickText(d);
}

// =====================================================
// LONGFORM (existing) — keep as-is (minimal changes)
// =====================================================
const MIN_SCRIPT_CHARS = 6000;

function buildHardSpec(topic, title) {
  return `
[HARD SPEC - MUST FOLLOW]
주제: ${topic}
제목: ${title}
대상: 한국 시니어(50~70대)

[출력 형식]
- 출력은 "대본 텍스트"만.
- 목록/번호/소제목은 허용(가독성 위해).
- 메타설명/사과/AI 언급/마크다운/JSON/코드블록 금지.

[절대 길이 규칙]
- 최종 대본은 반드시 한국어 글자 수 ${MIN_SCRIPT_CHARS}자 이상.
- **한 번의 출력 안에서 ${MIN_SCRIPT_CHARS}자 이상이 될 때까지 계속 이어서 작성한다.**
- 중간에 “이상입니다/마무리/요약/결론” 같은 종료 신호를 ${MIN_SCRIPT_CHARS}자 달성 전에는 절대 쓰지 마라.
- 글자 수가 부족하다고 느끼면, 같은 출력 안에서 즉시 아래 [확장 프로토콜]을 실행하라.

[확장 프로토콜(부족하면 자동 실행)]
1) 각 섹션에 “구체 사례/상황/대화/숫자/실수”를 추가한다.
2) 체크리스트를 10개 → 15개로 늘리고, 각 항목에 이유 1문장 추가.
3) ‘오늘 당장 행동’을 7개 → 10개로 늘린다.
4) 흔한 오해/실수 5가지를 추가하고, 각 항목에 바로잡는 문장 2개 추가.
5) 마지막에만 1~2문장 결론(그 전에는 금지).

[구조(순서 고정)]
1) 오프닝 훅(공감+문제 제기) 최소 6문단
2) 핵심 설명(원리/배경) 최소 6문단
3) 사례 3개(각 최소 3문단)
4) 체크리스트 15개(각 2문장: '왜' + '어떻게')
5) 오늘 당장 행동 10개(각 1문장)
6) 마무리: 요약 2문단 + 결론 1~2문장

[문장 스타일]
- 쉬운 단어, 짧은 호흡 섞기(자막용 한 문장 강조 포함)
- 각 문단 최소 3문장, 전체 문단 20개 이상
- 너무 빠르게 결론 내지 말 것
[END HARD SPEC]
`.trim();
}

async function makeTitle(topic) {
  const raw = await callResponses(
    `주제: ${topic}\n\n시니어 유튜브용 제목을 5개 후보로 제시하고, 첫 줄에 가장 좋은 1개를 출력해라.\n형식: 1줄 제목만.`,
    800,
    "You are a Korean YouTube title writer for seniors. Output only one title line."
  );
  const first = String(raw || "").split("\n").map(s => s.trim()).filter(Boolean)[0] || topic;
  return first.slice(0, 60);
}

async function generateScript(topic) {
  const title = await makeTitle(topic);

  const basePrompt =
    `주제: ${topic}\n제목: ${title}\n` +
    `요청: 한국어 내레이션 대본을 작성하라.\n` +
    `최종 길이는 반드시 ${MIN_SCRIPT_CHARS}자 이상.\n\n` +
    buildHardSpec(topic, title);

  // 1) first draft
  let script = String(await callResponses(
    basePrompt,
    16000,
    "You are a Korean voiceover script writer for seniors. Follow the HARD SPEC exactly."
  ) || "").trim();
  log("SCRIPT_LEN:", script.length, "phase=first");

  // 2) continue writing if too short (accumulate)
  for (let k = 1; k <= 3 && script.length < MIN_SCRIPT_CHARS; k++) {
    const need = MIN_SCRIPT_CHARS - script.length;

    const contPrompt =
      `[이어쓰기 ${k}]\n` +
      `아래 대본은 아직 글자 수가 부족하다. (${script.length}자)\n` +
      `반드시 같은 톤/형식으로 "중간부터 이어서" 작성하라.\n` +
      `절대 반복/요약하지 말고, 새로운 내용으로 확장하라.\n` +
      `추가로 최소 ${Math.max(1200, Math.min(2500, need + 600))}자 이상을 더 작성하라.\n` +
      `※ ${MIN_SCRIPT_CHARS}자 달성 전에는 마무리/결론 문장을 쓰지 마라.\n\n` +
      `--- 기존 대본(끝부분 참고) ---\n` +
      script.slice(Math.max(0, script.length - 1200)) +
      `\n--- 여기서부터 이어쓰기 ---\n`;

    const add = String(await callResponses(
      contPrompt,
      16000,
      "You are a Korean voiceover script writer for seniors. Continue the script without repeating."
    ) || "").trim();

    if (add) script = (script + "\n\n" + add).trim();
    log("SCRIPT_LEN:", script.length, `phase=cont${k}`);
  }

  if (script.length < MIN_SCRIPT_CHARS) {
    throw new Error(`Failed to generate sufficiently long script (min=${MIN_SCRIPT_CHARS})`);
  }

  return { title, script };
}

// =========================
// TTS (existing)
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
// Images (existing - Pixabay required)
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
// Video: slideshow length = audio length (existing)
// =========================
async function getMp3DurationSec(mp3Path) {
  const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${mp3Path}"`;
  const outp = execSync(cmd, { encoding: "utf8" }).trim();
  const sec = Math.max(1, Math.round(Number(outp) || 0));
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

// =====================================================
// SHORTS ENGINE (NEW) — 30s shorts scripts + Luma prompt
// =====================================================

// Generation templates per age bucket (from your baseline)
function ageBucketTemplate(ageBucket) {
  const b = String(ageBucket || "").trim();
  switch (b) {
    case "10s":
      return { bucket: "10s", driver: "공감/소속감", tone: "가볍고 빠르게, 밈/공감 포인트", cta: "댓글로 공감/경험 공유" };
    case "20s":
      return { bucket: "20s", driver: "가성비/정보", tone: "핵심만, 수치/비교", cta: "저장/공유/꿀팁 요청" };
    case "30_40s":
      return { bucket: "30_40s", driver: "건강/시간절약/현실이득", tone: "현실 조언, 시간 아끼는 포인트", cta: "내 상황 댓글/체크" };
    case "50p":
      return { bucket: "50p", driver: "건강정보/경고/신뢰", tone: "차분하지만 단호, 안전/주의", cta: "본인 상황 1번/2번 선택 댓글" };
    default:
      return { bucket: "auto", driver: "혼합", tone: "명확/간결", cta: "선택형 질문 댓글" };
  }
}

// Policy-safe constraints for monetization stability (no explicit guideline quotes)
function policyGuardrails() {
  return `
[정책/수익 안전 가드레일]
- 혐오/차별/폭력 조장/성적 콘텐츠/불법행위/위험행위 유도 금지.
- 과도한 공포 조장(극단적 단정, 위협) 금지. 다만 '주의/경고'는 사실 기반으로.
- 건강/의학은 "일반 정보" 수준. 진단/처방 단정 금지. 필요 시 "의심되면 전문가 상담" 한 문장 허용.
- 허위 사실처럼 단정 금지. 모르는 수치는 "대략/일반적으로" 처리.
- 유명인/상표를 과도하게 끌어오지 말 것.
- 노래 가사/저작권 문구/기사 전문 인용 금지.
`.trim();
}

function shortsHardSpec(topic, tpl, idx, seedHint) {
  return `
[SHORTS HARD SPEC - MUST FOLLOW]
목표: 30초 쇼츠. 스와이프 방지 + 반복 재생(루프) + 댓글 유도 포함.

주제: ${topic}
타겟: ${tpl.bucket} (${tpl.driver})
톤: ${tpl.tone}
콜투액션 방향: ${tpl.cta}
추가 힌트(있으면 반영): ${seedHint || "없음"}
버전: #${idx}

[구조(초 단위)]
[HOOK 규칙]
- 첫 문장에는 반드시 강한 결과 표현(치명적, 심각, 망가집니다, 위험합니다 중 하나)을 포함한다.
- Hook의 50%는 [삐—] 표현을 사용한다.
- 첫 문장은 반드시 단정형 또는 경고형으로 시작한다.
- 첫 문장에 ‘줄입니다/감소합니다/낮아집니다/영향을 미칩니다’와 같은 약한 표현만 있을 경우, 반드시 ‘치명적입니다/심각합니다/망가집니다/위험합니다’ 중 하나로 변환한다.
- 중립적 질문형(“아시나요?”, “안녕하신가요?” 등)은 금지한다.
- TOP_TEXT는 7~12자의 짧고 강한 위기 자막으로 작성한다.
- 반드시 위험 또는 손실 또는 숫자 중 하나를 포함한다.
- 추상적인 단어(건강, 정보, 주의 등 단독 사용)는 금지한다.
[영상 시작 규칙]
- 첫 프레임은 0.5초 동안 정지 화면을 사용한다.
- 첫 프레임에는 TOP_TEXT 자막만 크게 표시한다.
- 첫 프레임에서는 카메라 이동, 줌, 전환 효과를 사용하지 않는다.
- 0.5초 이후에 영상 움직임을 시작한다.
- 첫 프레임의 자막은 위기감 또는 손실을 표현하는 문장이어야 한다.
- 첫 프레임 자막은 7~12자 이내로 제한한다.
- 첫 프레임 자막에는 추상적 표현(건강, 정보, 중요 등)만 단독으로 사용하지 않는다.
- 첫 프레임 자막에는 반드시 결과 또는 위험 대상이 포함되어야 한다.
- 첫 프레임 자막은 명사형 또는 단정형으로 끝난다. (예: "혈관이 막힙니다", "뇌가 늙습니다")
- 첫 프레임 자막에는 숫자 또는 신체 부위(뇌, 혈관, 심장, 눈, 관절 등)가 포함되면 우선 사용한다.
- 첫 프레임 자막은 가능하면 10자 이내의 짧은 문장을 우선 사용한다.

[손실/위험] + [결과] + [시간 예고]
- HOOK에는 반드시 다음 3요소가 포함되어야 한다:
  1) 위험 또는 손실
  2) 시간(숫자 포함)
  3) 결과

- Hook의 마지막 문장은 반드시 시간 예고 문장으로 끝난다.
  예: "30초 뒤에 이유를 알려드립니다."

- 0~2초: 강한 후크(1문장) + 첫 프레임 자막(7~12자)
- 3~20초: 핵심 내용(3~5문장, 최대한 구체)
- 20~30초: 행동 유도 + 루프 문장(마지막 문장이 첫 문장으로 자연 연결)

[반드시 포함]
1) 스와이프 방지 장치: "30초 뒤 공개/끝에 한 가지/방금 말한 것의 함정" 같은 리텐션 장치 1개
2) 무한 루프: 마지막 문장 → 첫 문장 자연 연결
3) 댓글 유도: 마지막 2초에 "선택형 질문" 1개
4) CTA_LOOP는 반드시 질문형 또는 행동 유도 문장으로 끝난다.
CTA_LOOP는 시청자가 자신의 상태를 떠올리게 해야 한다.
예: "그래서 오늘 밤, 몇 시에 주무실 건가요?"
예: "지금 당신의 수면 시간은 몇 시간입니까?"


[출력 형식(JSON 금지)]
아래 라벨을 그대로 쓰고, 각 항목은 한 줄 또는 짧은 문단:
HOOK:
TOP_TEXT:
SFX_START:
BODY:
CTA_LOOP:
COMMENT_Q:
LUMA_PROMPT:
RUNWAY_PROMPT:

[영상 프롬프트 규칙]
- 세로 9:16, 고해상도, 리얼/시네마틱 중 선택
- 첫 프레임 강한 장면. 자막 얹기 쉬운 여백 고려.
- 과도한 폭력/의료 시술/선정/혐오 묘사 금지.

${policyGuardrails()}
[END SHORTS HARD SPEC]
`.trim();
}

function parseShortsBlock(text) {
  const t = String(text || "");
  const get = (label) => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, "m");
    const m = t.match(re);
    return (m?.[1] || "").trim();
  };
  return {
    hook: get("HOOK"),
    top_text: get("TOP_TEXT"),
    sfx_start: get("SFX_START"),
    body: get("BODY"),
    cta_loop: get("CTA_LOOP"),
    comment_q: get("COMMENT_Q"),
    luma_prompt: get("LUMA_PROMPT"),
    runway_prompt: get("RUNWAY_PROMPT"),
    raw: t.trim(),
  };
}

// Topic “터지는 주제” 생성: 주제 10개 뽑고, 그중 N개 사용
async function generateHotTopics(seedTopic, count, ageBucket) {
  const tpl = ageBucketTemplate(ageBucket);

  // seedTopic must dominate
  const core = String(seedTopic || "").trim();
  if (!core) throw new Error("seedTopic (topic) is required");

  const n = Math.max(5, Number(count) || 10);

  const prompt = `
목표: "${core}" 주제에 100% 고정된 유튜브 쇼츠용 '파생 주제'만 생성한다.
조건:
- 반드시 "${core}"와 직접 관련되어야 한다. (무관한 주제 금지)
- "${core}"에서 벗어나는 요리/여행/DIY/개그 등 랜덤 주제 생성 금지.
- ${tpl.driver}에 맞는 훅이 나오는 파생 주제.
- 각 주제는 18자 이내, 한국어, 간결.
- 과장/허위 단정 금지. 건강은 일반 정보 수준.
- 결과는 중복 없이.

출력 형식:
- 주제만 줄바꿈으로 ${Math.max(12, n)}개
- 번호/기호/설명/부연 금지 (주제 텍스트만)
`.trim();

  const raw = await callResponses(
    prompt,
    1400,
    "You generate Korean short-video derivative topics. Output ONLY topic lines, no numbering, no extra text."
  );

  const lines = String(raw || "")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^[\-\*\d\.\)\s]+/, "").trim())
    .filter(Boolean);

  // filter: must include core keyword tokens (loose)
  const mustTokens = core
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 3); // keep it robust

  const uniq = [];
  const seen = new Set();

  for (const x0 of lines) {
    const x = x0.slice(0, 30);
    const k = x.toLowerCase();
    if (seen.has(k)) continue;

    // Must be related: contains at least one token from core (or core itself)
    const ok =
      x.includes(core) ||
      mustTokens.some(t => t && x.includes(t));

    if (!ok) continue;

    seen.add(k);
    uniq.push(x);
    if (uniq.length >= Math.max(10, n)) break;
  }

  // Ensure enough: force-generate safe derivatives if model under-produces
  while (uniq.length < Math.max(10, n)) {
    const i = uniq.length + 1;
    const fallback = `${core} 꿀팁 ${i}`;
    const k = fallback.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(fallback.slice(0, 18));
    } else {
      uniq.push(`${core} 체크 ${i}`.slice(0, 18));
    }
  }

  // Always include the core as the first candidate (fixed anchor)
  const anchored = [core, ...uniq.filter(t => t !== core)];

  return anchored.slice(0, Math.max(10, n));
}

async function generateOneShort({ topic, ageBucket, idx, seedHint }) {
  const tpl = ageBucketTemplate(ageBucket);
  const spec = shortsHardSpec(topic, tpl, idx, seedHint);

  const raw = await callResponses(
    spec,
    1400,
    "You are a Korean Shorts scriptwriter. Follow the SHORTS HARD SPEC. Output only the labeled fields. No markdown, no JSON."
  );
const parsed = parseShortsBlock(raw);
parsed.cta_loop = forceCtaLoop(topic, parsed.cta_loop, parsed.hook);

  // Minimal validation (to reduce broken outputs)
  if (!parsed.hook || !parsed.body || !parsed.cta_loop || !parsed.comment_q || !parsed.luma_prompt) {
    // one retry with stricter instruction
    const raw2 = await callResponses(
      spec + "\n\n[재시도]\n위 라벨 8개를 빠짐없이 채워라. 빈칸 금지.",
      1400,
      "You are a Korean Shorts scriptwriter. Output only the labeled fields. No markdown, no JSON."
    );
    const parsed2 = parseShortsBlock(raw2);
    return { ...parsed2, age_bucket: tpl.bucket, driver: tpl.driver };
  }

  return { ...parsed, age_bucket: tpl.bucket, driver: tpl.driver };
}

async function makeShortsPack({ seedTopic, count, ageBucket, seedHint }) {
  // count: 1..100 (your baseline: 10 now, 100 soon)
  const n = clampInt(count, 1, 100, 10);

  // 1) Hot topics
  const topics = await generateHotTopics(seedTopic, Math.max(10, n), ageBucket);
  const picked = topics.slice(0, n);

  // 2) Generate shorts one by one (stable)
  const shorts = [];
  for (let i = 0; i < picked.length; i++) {
    const s = await generateOneShort({
      topic: picked[i],
      ageBucket,
      idx: i + 1,
      seedHint,
    });
    shorts.push({
      idx: i + 1,
      topic: picked[i],
      ...s,
    });
  }

  return { topics_candidate: topics, shorts };
}

// =====================================================
// MAIN (mode switch)
// =====================================================
async function main() {
  const req = safeJson(fs.readFileSync("req.json", "utf-8")) || {};

  const mode = String(req.mode || req.type || "longform").trim().toLowerCase();
  const topic = typeof req.topic === "string" ? req.topic.trim() : "";
  const seedHint = typeof req.hint === "string" ? req.hint.trim() : "";
  const ageBucket = typeof req.ageBucket === "string" ? req.ageBucket.trim() : "auto";
  const count = req.count ?? req.n ?? 10;

  if (!topic) throw new Error("Missing topic in req.json");

  const id = crypto.randomBytes(6).toString("hex");
  const outDir = path.resolve(process.cwd(), "out", id);
  ensureDir(outDir);

  // -------------------------
  // SHORTS MODE (NEW)
  // -------------------------
  if (mode === "shorts" || mode === "short" || mode === "s") {
    const pack = await makeShortsPack({
      seedTopic: topic,
      count,
      ageBucket,
      seedHint,
    });

    // Save an artifact for ops (optional but helpful)
    const jsonPath = path.join(outDir, `${id}-shorts.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(pack, null, 2), "utf8");

    return {
      ok: true,
      mode: "shorts",
      parsed: {
        id,
        seedTopic: topic,
        ageBucket,
        count: clampInt(count, 1, 100, 10),
        out_dir: outDir,
        shorts_json: jsonPath,
        ...pack,
      },
      // download_url kept for compatibility; for shorts it's a JSON artifact
      download_url: `/download?token=${id}`,
      ms: Date.now() - t0,
    };
  }

  // -------------------------
  // LONGFORM MODE (EXISTING)
  // -------------------------
  const { title, script } = await generateScript(topic);
  const ttsPath = await generateTTSMp3({ id, script, outDir });
  const { outMp4Path, durationSec } = await makeVideo({ id, ttsPath, outDir, topic });

  return {
    ok: true,
    mode: "longform",
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
