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
    bgm: { preset: "", duration_sec: 0, download_url: "" }, // download_url 여기 채움
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
 * AI Slop 방지 - Quality Gate v2
 * (출력 자체를 막아 유튜브 리스크 제거)
 * ========================= */

function qualityGateV2({ title, script }) {
  const t = (title || "") + "\n" + (script || "");
  const hasNumber = /\d/.test(t);
  const hasAction = /(하세요|해보세요|지금|바로|체크|멈추|줄이|늘리|기록)/.test(t);
  const hasTarget = /(40대|50대|60대|70대|중장년|시니어|무릎|허리|혈압|당뇨|수면|치매)/.test(t);

  // "사례 문장" 최소 3개 (아주 단순 휴리스틱)
  const exampleCount =
    (t.match(/예를 들어/g) || []).length +
    (t.match(/사례/g) || []).length +
    (t.match(/저희가 상담했던/g) || []).length +
    (t.match(/많은 분들이 실제로/g) || []).length;

  // 구조 키워드 존재(훅/공감/방법/실수/행동)
  const hasStructure =
    /(Hook|훅|공감)/i.test(t) &&
    /(방법 1|첫 번째|1\))/i.test(t) &&
    /(방법 2|두 번째|2\))/i.test(t) &&
    /(방법 3|세 번째|3\))/i.test(t) &&
    /(실수|주의)/.test(t) &&
    /(오늘 바로|지금 할 행동|마무리)/.test(t);

  // AI 슬롭 대표 일반론 과다(대충 방지)
  const vagueCount = (t.match(/(중요합니다|도움이 됩니다|좋습니다|필요합니다)/g) || []).length;

  const ok =
    hasNumber &&
    hasAction &&
    hasTarget &&
    exampleCount >= 3 &&
    hasStructure &&
    vagueCount <= 10;

  return {
    ok,
    reasons: {
      hasNumber,
      hasAction,
      hasTarget,
      exampleCount,
      hasStructure,
      vagueCount,
    },
  };
}

/* =========================
 * Prompt (유튜브 생존형 v2)
 * ========================= */

function estimateWordTarget(durationSec) {
  // 보수적으로 135 wpm 기준 (시니어 차분 톤)
  const wpm = 135;
  const minutes = Math.max(1, Number(durationSec || 900) / 60);
  return Math.round(wpm * minutes);
}

function buildSystemPrompt({ durationSec }) {
  const wordTarget = estimateWordTarget(durationSec);

  return `
Return ONLY valid JSON.
No explanation.
No markdown.

당신은 '시니어 대상 유튜브 영상' 전문 작가다.
AI 티(일반론 반복, 의미없는 문장, 빈약한 정보)를 절대 내지 마라.
실제 도움이 되는 "실천형 정보"만 작성한다.

[영상 목적]
- 실제 도움이 되는 정보 제공
- 시청 유지율 50% 이상 목표

[구조 규칙]
1) 시작 15초 Hook: 문제 상황 → 해결 가능성 → 오늘 얻을 결과
2) 공감 구간: 많은 사람들이 겪는 상황을 구체적으로
3) 핵심 정보: 방법 3개 제시
   - 각 방법은 반드시 "무엇을 → 왜 → 어떻게" 순서로 작성
4) 실수 방지 구간: 사람들이 흔히 하는 실수/주의점
5) 행동 지시로 마무리: 오늘 바로 할 행동 1개

[작성 규칙]
- 20~30초마다 새로운 정보(새 팁/새 숫자/새 체크포인트)가 나오게 구성
- 사례 문장 최소 3개 포함(예: "예를 들어..." / "사례로...")
- 숫자 반드시 포함(시간/횟수/개수 등)
- 행동 지시 반드시 포함
- 설명이 아니라 실천 중심(체크리스트/단계/루틴)

[톤]
- 차분하고 신뢰감
- 쉬운 표현

[길이 규칙]
- 롱폼은 말로 읽었을 때 약 ${durationSec}초를 목표로 한다.
- 최소 목표 분량: 약 ${wordTarget} 단어 수준(짧게 쓰지 마라).

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

규칙 준수용 섹션 헤더를 script에 명시해라:
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

반드시 한국어.
숏폼 3개는 30~50초 분량으로, 1문장 훅 + 3스텝 + 1문장 결론.
썸네일 문구 3개는 클릭 유도형이되 과장/공포 조장 금지(신뢰 우선).
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
    temperature: 0.6, // 신뢰/일관성 우선
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
 * - WORKER_URL이 HTTP 엔드포인트(/render)를 제공할 때 download_url 채움
 * - 실패해도 텍스트 결과는 반환(운영 안정성)
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
    return { ok: false, reason: e?.name === "AbortError" ? "WORKER_TIMEOUT" : "WORKER_FETCH_FAIL", detail: String(e) };
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

  // ✅ AI Slop 방지 게이트(롱폼 기준)
  const gate = qualityGateV2({ title: data.longform.title, script: data.longform.script });
  if (!gate.ok) {
    return res.status(422).json({
      ok: false,
      code: "QUALITY_GATE_FAIL",
      message: "script quality gate failed (anti-AI-slop)",
      detail: gate.reasons,
      data,
    });
  }

  // ✅ 영상 단계 연결(가능하면 download_url 채움)
  const workerResult = await tryCallWorkerRender(data);
  if (!workerResult.ok) {
    // 운영상 실패해도 텍스트 결과는 반환. 로그로만 남김.
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
