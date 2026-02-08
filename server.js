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
 * Retention/SEO 계산(게이트 기준용)
 * ========================= */

function requiredRetentionBeats(durationSec) {
  // 8~12분(480~720)면 최소 4~6개, 15분(900)면 최소 7개 정도로 강제(너무 빡세지 않게)
  const sec = Math.max(60, Number(durationSec || 900));
  const beats = Math.floor(sec / 120); // 2분마다 최소 1번 리텐션 비트
  return Math.max(4, Math.min(10, beats));
}

/* =========================
 * AI Slop 방지 + Retention 게이트 v3
 * ========================= */

function qualityGateV3({ title, script, durationSec }) {
  const t = (title || "") + "\n" + (script || "");

  // 기본 필수
  const hasNumber = /\d/.test(t);
  const hasAction = /(하세요|해보세요|지금|바로|체크|멈추|줄이|늘리|기록|설정)/.test(t);
  const hasTarget = /(40대|50대|60대|70대|중장년|시니어|무릎|허리|혈압|당뇨|수면|치매)/.test(t);

  // 사례 3개를 "형식"으로 강제
  const caseLines = (t.match(/사례\s*[1-3]\s*:/g) || []).length;
  const has3Cases = caseLines >= 3;

  // 구조(섹션 헤더)
  const hasStructure =
    /\[Hook\]/.test(t) &&
    /\[공감\]/.test(t) &&
    /\[방법 1: 무엇을\/왜\/어떻게\]/.test(t) &&
    /\[방법 2: 무엇을\/왜\/어떻게\]/.test(t) &&
    /\[방법 3: 무엇을\/왜\/어떻게\]/.test(t) &&
    /\[실수 방지\]/.test(t) &&
    /\[오늘 바로 할 행동\]/.test(t);

  // Retention 비트(중간 이탈 방지 장치)
  // 모델이 20~30초마다 새 정보를 주되, 최소한 2분마다 '리텐션 비트'를 넣게 강제
  const beatCount = (t.match(/리텐션 비트\s*\d+\s*:/g) || []).length;
  const needBeats = requiredRetentionBeats(durationSec);
  const hasBeats = beatCount >= needBeats;

  // 슬롭 일반론 과다 방지
  const vagueCount = (t.match(/(중요합니다|도움이 됩니다|좋습니다|필요합니다)/g) || []).length;

  const ok =
    hasNumber &&
    hasAction &&
    hasTarget &&
    hasStructure &&
    has3Cases &&
    hasBeats &&
    vagueCount <= 12;

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
    },
  };
}

/* =========================
 * Prompt (유튜브 생존형 v3: Retention + SEO/CTR 내장)
 * ========================= */

function estimateWordTarget(durationSec) {
  const wpm = 135; // 시니어 차분 톤
  const minutes = Math.max(1, Number(durationSec || 900) / 60);
  return Math.round(wpm * minutes);
}

function buildSystemPrompt({ durationSec }) {
  const wordTarget = estimateWordTarget(durationSec);
  const needBeats = requiredRetentionBeats(durationSec);

  return `
Return ONLY valid JSON.
No explanation.
No markdown.

당신은 2026년 기준 '시니어 유튜브'에서 살아남는 스크립트 작가다.
AI 슬롭(일반론 반복, 빈약한 정보, 뻔한 문장)처럼 보이면 실패다.
목표는 "시청 유지율 50% 이상"을 노리는 구성이다.

[유튜브 상위 노출 확률을 높이는 3요소(코드 강제)]
1) CTR: 제목/썸네일이 "누가/무슨 문제/얼마나/결과"를 즉시 말한다(과장·공포 금지).
2) Retention: 중간 이탈 방지 장치를 주기적으로 넣는다(오픈루프/다음에 얻는 것/즉시 적용).
3) Satisfaction: 실천 가능한 체크리스트/숫자/주의사항/오늘 행동 1개로 끝낸다.

[영상 목적]
- 실제 도움이 되는 정보 제공
- 시청 유지율 50% 이상 목표

[구조 규칙]
1) 시작 15초 Hook: 문제 상황 → 해결 가능성 → 오늘 얻을 결과
2) 공감 구간: 많은 사람들이 겪는 상황을 구체적으로
3) 핵심 정보: 방법 3개
   - 각 방법은 반드시 "무엇을 → 왜 → 어떻게" 순서
4) 실수 방지: 흔한 실수/주의점
5) 행동 지시: 오늘 바로 할 행동 1개

[작성 규칙(강제)]
- 20~30초마다 새로운 정보(새 팁/새 숫자/새 체크포인트)가 나오게 구성
- 숫자 반드시 포함(시간/횟수/개수 등)
- 행동 지시 반드시 포함
- "사례 1/2/3"을 아래 형식으로 정확히 3줄 포함:
  사례 1: ...
  사례 2: ...
  사례 3: ...
- Retention 장치(중간 이탈 방지) 최소 ${needBeats}개를 아래 형식으로 포함:
  리텐션 비트 1: ...
  리텐션 비트 2: ...
  (각 비트는 '다음에 얻는 것/지금 체크/놓치면 손해' 중 하나를 포함)

[톤]
- 차분하고 신뢰감
- 쉬운 표현

[길이]
- 롱폼은 말로 읽었을 때 약 ${durationSec}초 목표
- 최소 목표 분량: 약 ${wordTarget} 단어 수준(짧게 쓰지 마라)

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

롱폼 script는 아래 섹션 헤더를 반드시 포함:
[Hook]
[공감]
[방법 1: 무엇을/왜/어떻게]
[방법 2: 무엇을/왜/어떻게]
[방법 3: 무엇을/왜/어떻게]
[실수 방지]
[오늘 바로 할 행동]

`.trim();
}

function buildUserPrompt({ topic, topicTone }) {
  const safeTopic = topic || "시니어 건강 정보";

  return `
주제: ${safeTopic}
톤: ${topicTone || "CALM"}

[제목/썸네일 규칙(CTR)]
- 제목: 검색 의도형(문제+대상+숫자+결과)로 작성. 예: "60대 무릎통증, 3분 루틴으로 30% 줄이는 법"
- 썸네일 문구 3개: 12~18자 내외로 간결하게. 과장/공포조장 금지(신뢰 우선).

[숏폼 규칙]
- 30~50초 분량
- 1문장 훅 + 3스텝(숫자 포함) + 1문장 결론(행동 지시)

반드시 한국어.
JSON만 출력.
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
      { role: "system", content: buildSystemPrompt({ durationSec }) },
      { role: "user", content: buildUserPrompt({ topic, topicTone }) },
    ],
    temperature: 0.6,
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
    try {
      j = JSON.parse(text);
    } catch (_) {}

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

  // ✅ Quality Gate(리텐션/사례/구조/숫자/행동 강제)
  const gate = qualityGateV3({
    title: data.longform.title,
    script: data.longform.script,
    durationSec,
  });

  if (!gate.ok) {
    return res.status(422).json({
      ok: false,
      code: "QUALITY_GATE_FAIL",
      message: "script quality gate failed (anti-AI-slop + retention)",
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

app.get("/", (req, res) => {
  res.send("finishflow-live is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    model: OPENAI_MODEL,
    hasWorkerUrl: !!WORKER_URL,
    workerUrl: WORKER_URL ? WORKER_URL : "",
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
});
