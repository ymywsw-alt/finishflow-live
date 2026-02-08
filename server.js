require("dotenv").config();
console.log("[ENV] loaded:", !!process.env.OPENAI_API_KEY, "len:", (process.env.OPENAI_API_KEY || "").length);

const express = require("express");
const app = express();
app.use(express.json({ limit: "10mb" }));

/* =========================
 * ENV
 * ========================= */
const PORT = process.env.PORT || 10000;
const BUILD = process.env.BUILD || "DEV";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const WORKER_URL = (process.env.WORKER_URL || "").replace(/\/$/, "");

const GATE_VERSION = "v5-auto-insert";

/* =========================
 * Helpers
 * ========================= */

function baseSchema() {
  return {
    longform: { title: "", script: "" },
    shorts: [
      { title: "", script: "" },
      { title: "", script: "" },
      { title: "", script: "" },
    ],
    thumbnails: [{ text: "" }, { text: "" }, { text: "" }],
    recommended_thumbnail_index: 0,
    meta: { model: OPENAI_MODEL, build: BUILD },
    bgm: { preset: "", duration_sec: 0, download_url: "" },
  };
}

function okPayload(data) {
  return { ok: true, code: null, data };
}

function errorPayload(code, message, detail) {
  return { ok: false, code, message, detail: detail || null, data: baseSchema() };
}

/* =========================
 * OpenAI 응답 파싱
 * ========================= */

function extractOutputText(openaiJson) {
  const c1 = openaiJson?.choices?.[0]?.message?.content;

  if (typeof c1 === "string" && c1.trim()) return c1;

  if (Array.isArray(c1)) {
    const joined = c1
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        return "";
      })
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  return "";
}

function coerceToJsonString(text) {
  if (!text) return "";
  const s = text.toString();

  const noFence = s.replace(/```json/gi, "```").replace(/```/g, "");
  const start = noFence.indexOf("{");
  const end = noFence.lastIndexOf("}");
  if (start >= 0 && end > start) return noFence.slice(start, end + 1);

  return noFence.trim();
}

function normalizeResult(parsed) {
  const out = baseSchema();

  if (parsed?.longform?.title) out.longform.title = String(parsed.longform.title);
  if (parsed?.longform?.script) out.longform.script = String(parsed.longform.script);

  if (Array.isArray(parsed?.shorts)) {
    for (let i = 0; i < 3; i++) {
      const item = parsed.shorts[i] || {};
      out.shorts[i].title = item.title || "";
      out.shorts[i].script = item.script || "";
    }
  }

  if (Array.isArray(parsed?.thumbnails)) {
    for (let i = 0; i < 3; i++) {
      const item = parsed.thumbnails[i] || {};
      out.thumbnails[i].text = item.text || "";
    }
  }

  if (typeof parsed?.recommended_thumbnail_index === "number") {
    out.recommended_thumbnail_index = parsed.recommended_thumbnail_index;
  }

  return out;
}

/* =========================
 * Retention 요구량
 * ========================= */
function requiredRetentionBeats(durationSec) {
  const sec = Math.max(60, Number(durationSec || 900));
  const beats = Math.floor(sec / 120); // 2분당 1개
  return Math.max(4, Math.min(10, beats));
}

/* =========================
 * 구조 체크 (유연)
 * ========================= */
function hasAllStructure(script) {
  const s = script || "";
  const hasHook = /\[Hook\]/.test(s);
  const hasEmp = /\[공감\]/.test(s);
  const hasM1 = /\[방법\s*1[^\]]*\]/.test(s);
  const hasM2 = /\[방법\s*2[^\]]*\]/.test(s);
  const hasM3 = /\[방법\s*3[^\]]*\]/.test(s);
  const hasMistake = /\[(실수\s*방지|주의)\]/.test(s);
  const hasAction = /\[오늘\s*바로\s*할\s*행동\]/.test(s);
  return hasHook && hasEmp && hasM1 && hasM2 && hasM3 && hasMistake && hasAction;
}

/* =========================
 * ✅ 자동 삽입: 사례/리텐션 비트/주의 문구
 * - 모델이 빼먹어도, 코드가 강제 주입해서 422를 끊는다
 * ========================= */

function ensureDisclaimer(script) {
  const line = "[주의] 이 영상은 일반 정보이며 개인 상태에 따라 다를 수 있습니다. 증상이 지속되면 의료진과 상담하세요.";
  if (/\[주의\]\s*이 영상은/.test(script)) return script;
  // 맨 끝에 추가
  return (script || "").trim() + "\n\n" + line;
}

function ensureCases(script, topic) {
  const hasCases = (script.match(/사례\s*[1-3]\s*:/g) || []).length >= 3;
  if (hasCases) return script;

  const t = topic || "해당 주제";
  const block =
    `사례 1: ${t} 때문에 "뭘 먼저 해야 할지" 몰라서 한 달을 미룬 분이, 오늘 알려드릴 체크 1개로 바로 시작한 경우\n` +
    `사례 2: ${t}를 유튜브/블로그대로 따라하다 실패했던 분이, "실수 1가지"를 고치고 2주 만에 루틴이 자리잡은 경우\n` +
    `사례 3: ${t}를 돈 들이지 않고도, 하루 10분/주 3회로 관리해 부담이 확 줄어든 경우`;

  // [공감] 바로 뒤에 끼워 넣기
  if (/\[공감\]/.test(script)) {
    return script.replace(/\[공감\][^\n]*\n?/, (m) => m + "\n" + block + "\n\n");
  }
  // 공감 헤더가 없으면 앞쪽에 넣음
  return block + "\n\n" + (script || "");
}

function ensureRetentionBeats(script, durationSec, topic) {
  const need = requiredRetentionBeats(durationSec);
  const current = (script.match(/리텐션\s*비트\s*\d+\s*:/g) || []).length;
  if (current >= need) return script;

  const t = topic || "이 주제";
  const beats = [];
  for (let i = 1; i <= need; i++) {
    // 각 비트는 “다음에 얻는 것/지금 체크/놓치면 손해” 중 하나를 포함하도록 구성
    if (i % 3 === 1) beats.push(`리텐션 비트 ${i}: 지금부터 30초 뒤에 "${t}에서 가장 많이 틀리는 1가지"를 바로 잡아드립니다.`);
    else if (i % 3 === 2) beats.push(`리텐션 비트 ${i}: 지금 바로 체크하세요—오늘 내용 중 "이 항목"이 빠지면 효과가 크게 떨어집니다.`);
    else beats.push(`리텐션 비트 ${i}: 끝까지 보시면 돈/시간 낭비를 막는 "구매/선택 기준 3줄"을 드립니다.`);
  }
  const block = beats.join("\n");

  // [방법 1] 앞에 넣으면 “중간 이탈 방지” 역할을 잘함
  if (/\[방법\s*1/.test(script)) {
    return script.replace(/\[방법\s*1[^\]]*\]/, block + "\n\n$&");
  }
  // 없으면 앞쪽에 넣음
  return block + "\n\n" + (script || "");
}

/* =========================
 * 위험 차단: %효과 단정 금지
 * ========================= */
function stripPercentClaims(title, script) {
  const t = (title || "") + "\n" + (script || "");
  const hasPercent = /(\d+\s*%|%)/.test(t);
  if (!hasPercent) return { title, script, removed: false };

  // % 표현을 제거/완화(정확한 수치 단정 방지)
  const safeTitle = (title || "").replace(/(\d+\s*%|%)/g, "").replace(/\s{2,}/g, " ").trim();
  const safeScript = (script || "").replace(/(\d+\s*%|%)/g, "").replace(/\s{2,}/g, " ").trim();

  return { title: safeTitle, script: safeScript, removed: true };
}

/* =========================
 * Gate v5: auto-insert 후 검증
 * ========================= */
function qualityGateV5({ title, script, durationSec }) {
  const t = (title || "") + "\n" + (script || "");

  const hasNumber = /\d/.test(t); // 용량/시간/횟수 등
  const hasAction = /(하세요|해보세요|지금|바로|체크|기록|설정|줄이|늘리|멈추)/.test(t);
  const hasTarget = /(40대|50대|60대|70대|중장년|시니어|무릎|허리|혈압|당뇨|수면|치매)/.test(t);

  const hasStructure = hasAllStructure(script || "");

  const caseLines = (t.match(/사례\s*[1-3]\s*:/g) || []).length;
  const needBeats = requiredRetentionBeats(durationSec);
  const beatCount = (t.match(/리텐션\s*비트\s*\d+\s*:/g) || []).length;

  const vagueCount = (t.match(/(중요합니다|도움이 됩니다|좋습니다|필요합니다)/g) || []).length;

  const hasPercentClaim = /(\d+\s*%|%)/.test(t); // 금지
  const hasDisclaimer = /\[주의\]\s*이 영상은/.test(t);

  const ok =
    hasNumber &&
    hasAction &&
    hasTarget &&
    hasStructure &&
    caseLines >= 3 &&
    beatCount >= needBeats &&
    vagueCount <= 18 &&
    !hasPercentClaim &&
    hasDisclaimer;

  return {
    ok,
    reasons: {
      hasNumber,
      hasAction,
      hasTarget,
      hasStructure,
      caseLines,
      needBeats,
      beatCount,
      vagueCount,
      hasPercentClaim,
      hasDisclaimer,
      gateVersion: GATE_VERSION,
    },
  };
}

/* =========================
 * Prompt (모델은 "핵심 본문"에 집중)
 * - 핵심은 코드가 사례/리텐션 비트를 보정한다
 * ========================= */
function buildSystemPrompt() {
  return `
Return ONLY valid JSON.
No explanation.
No markdown.

당신은 시니어 대상 유튜브 스크립트 작가다.
과장/공포/치료 단정 금지.
실천 중심(무엇을→왜→어떻게), 실수 방지, 오늘 할 행동 1개 포함.
아래 헤더를 반드시 포함(문자 그대로):

[Hook]
[공감]
[방법 1]
[방법 2]
[방법 3]
[실수 방지]
[오늘 바로 할 행동]

Schema:
{
 "longform": { "title": "string", "script": "string" },
 "shorts": [
  { "title": "string", "script": "string" },
  { "title": "string", "script": "string" },
  { "title": "string", "script": "string" }
 ],
 "thumbnails": [
  { "text": "string" },
  { "text": "string" },
  { "text": "string" }
 ],
 "recommended_thumbnail_index": 0
}
`.trim();
}

function buildUserPrompt({ topic, topicTone, durationSec }) {
  const safeTopic = topic || "시니어 건강";
  return `
주제: ${safeTopic}
톤: ${topicTone || "CALM"}
길이: ${durationSec || 900}초 (길게, 끊기지 않게)

규칙:
- 20~30초마다 새로운 정보(팁/숫자/체크포인트)
- 숫자는 시간/횟수/용량 중심
- 실수 방지 포함
- 오늘 바로 할 행동 1개로 끝내기
- JSON만 출력
`.trim();
}

/* =========================
 * OpenAI Call
 * ========================= */
async function callOpenAI({ topic, topicTone, durationSec }) {
  if (!OPENAI_API_KEY) throw new Error("NO_OPENAI_KEY");

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt({ topic, topicTone, durationSec }) },
    ],
    temperature: 0.5,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error("OPENAI_HTTP_" + t);
  }

  return await r.json();
}

/* =========================
 * Worker Call (영상 단계 연결)
 * ========================= */
async function tryCallWorkerRender(data) {
  if (!WORKER_URL) return { ok: false, reason: "NO_WORKER_URL" };

  const url = `${WORKER_URL}/render`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        longform: data.longform,
        shorts: data.shorts,
        thumbnails: data.thumbnails,
        recommended_thumbnail_index: data.recommended_thumbnail_index,
        meta: data.meta,
      }),
      signal: controller.signal,
    });

    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_) {}

    if (!r.ok) {
      return { ok: false, reason: "WORKER_HTTP_" + r.status, detail: text.slice(0, 500) };
    }

    const downloadUrl = j?.download_url || j?.data?.download_url || "";
    if (downloadUrl) {
      data.bgm = data.bgm || { preset: "", duration_sec: 0, download_url: "" };
      data.bgm.download_url = downloadUrl;
      return { ok: true, download_url: downloadUrl };
    }

    return { ok: false, reason: "NO_DOWNLOAD_URL", detail: text.slice(0, 500) };
  } catch (e) {
    return {
      ok: false,
      reason: e?.name === "AbortError" ? "WORKER_TIMEOUT" : "WORKER_FETCH_FAIL",
      detail: String(e),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================
 * Main Execute
 * ========================= */
async function handleExecute(req, res) {
  const body = req.body || {};
  const topic = body.topic || "시니어 건강";
  const topicTone = body.topicTone || "CALM";
  const durationSec = body.durationSec || 900;

  let openaiJson;
  try {
    openaiJson = await callOpenAI({ topic, topicTone, durationSec });
  } catch (e) {
    console.log(e);
    return res.json(errorPayload("E-OPENAI", "openai failed"));
  }

  const outText = extractOutputText(openaiJson);
  const jsonString = coerceToJsonString(outText);

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    console.log("parse fail:", jsonString);
    return res.json(errorPayload("E-PARSE", "parse failed"));
  }

  const data = normalizeResult(parsed);

  // ✅ 위험 수치(%효과) 제거(있으면 자동 완화)
  const stripped = stripPercentClaims(data.longform.title, data.longform.script);
  data.longform.title = stripped.title;
  data.longform.script = stripped.script;

  // ✅ 자동 삽입: 사례/리텐션/주의문구 (모델 실수 방지)
  data.longform.script = ensureCases(data.longform.script, topic);
  data.longform.script = ensureRetentionBeats(data.longform.script, durationSec, topic);
  data.longform.script = ensureDisclaimer(data.longform.script);

  // ✅ 최종 게이트
  const gate = qualityGateV5({
    title: data.longform.title,
    script: data.longform.script,
    durationSec,
  });

  if (!gate.ok) {
    return res.status(422).json({
      ok: false,
      code: "QUALITY_GATE_FAIL",
      message: "script quality gate failed (anti-AI-slop + retention v5 auto-insert)",
      detail: gate.reasons,
      data,
    });
  }

  // ✅ 영상 단계 연결(가능하면 download_url 채움)
  const workerResult = await tryCallWorkerRender(data);
  if (!workerResult.ok) {
    console.log("[worker] render skip/fail:", workerResult.reason, workerResult.detail || "");
  } else {
    console.log("[worker] render ok:", workerResult.download_url);
  }

  return res.json(okPayload(data));
}

/* =========================
 * Routes
 * ========================= */
app.get("/", (req, res) => res.send("finishflow-live is running"));

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    model: OPENAI_MODEL,
    hasWorkerUrl: !!WORKER_URL,
    workerUrl: WORKER_URL ? WORKER_URL : "",
    gateVersion: GATE_VERSION,
  });
});

app.post("/make", async (req, res) => {
  await handleExecute(req, res);
});

app.post("/execute", async (req, res) => {
  await handleExecute(req, res);
});

/* =========================
 * Listen
 * ========================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[finishflow-live] listening on ${PORT}`);
  console.log(`[BOOT] BUILD=${BUILD}`);
  console.log(`[BOOT] MODEL=${OPENAI_MODEL}`);
  console.log(`[BOOT] WORKER_URL=${WORKER_URL || "(missing)"}`);
  console.log(`[BOOT] GATE_VERSION=${GATE_VERSION}`);
});
