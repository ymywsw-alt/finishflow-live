const express = require("express");

const app = express();
app.use(express.json({ limit: "10mb" }));

/**
 * DEBUG: 런타임 환경변수 확인
 */
app.get("/debug/env", (req, res) => {
  const key = process.env.OPENAI_API_KEY || "";
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(key),
    keyPrefix: key ? key.slice(0, 7) : null,
    service: "finishflow-live",
    now: new Date().toISOString(),
  });
});

/**
 * (옵션) 간단 health
 */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * OpenAI Responses API에서 output_text 뽑기 (안전)
 */
function extractOutputText(data) {
  try {
    const arr = data.output || [];
    const msg = arr.find((x) => x.type === "message");
    const content = msg?.content || [];
    const txt = content.find((c) => c.type === "output_text");
    return txt?.text || "";
  } catch {
    return "";
  }
}

/**
 * ✅ 고정 결과 스키마: 롱폼1 + 숏폼3 + 썸네일3(추천1)
 * - URL이 없으면 "" 유지
 * - 배열 길이(3)는 항상 고정
 */
function buildFixedResult({
  longformUrl = "",
  longformDurationSec = 0,
  shortformUrls = [],
  shortformDurationsSec = [],
  thumbnailUrls = [],
} = {}) {
  const sUrls = Array.isArray(shortformUrls) ? shortformUrls : [];
  const sDur = Array.isArray(shortformDurationsSec) ? shortformDurationsSec : [];
  const tUrls = Array.isArray(thumbnailUrls) ? thumbnailUrls : [];

  return {
    longform: {
      videoUrl: String(longformUrl || ""),
      durationSec: Number(longformDurationSec || 0),
    },
    shortforms: [
      { videoUrl: String(sUrls[0] || ""), durationSec: Number(sDur[0] || 0) },
      { videoUrl: String(sUrls[1] || ""), durationSec: Number(sDur[1] || 0) },
      { videoUrl: String(sUrls[2] || ""), durationSec: Number(sDur[2] || 0) },
    ],
    thumbnails: [
      { imageUrl: String(tUrls[0] || ""), recommended: true },
      { imageUrl: String(tUrls[1] || ""), recommended: false },
      { imageUrl: String(tUrls[2] || ""), recommended: false },
    ],
  };
}

function errorPayload(errorCode, detail) {
  return {
    ok: false,
    errorCode,
    // 기존 호환(기존 UI가 error를 보던 경우 대비)
    error: errorCode,
    // 개발용 (길이 제한)
    detail: detail ? String(detail).slice(0, 2000) : null,
    // 스키마 고정: 실패해도 항상 존재
    result: buildFixedResult(),
    // 기존 호환: text 유지
    text: "",
  };
}

/**
 * ✅ (B) 국가/언어 옵션 1개로 프롬프트 자동 조립
 * - 학습/파인튜닝 아님: "프로그램 규칙" 고정
 * - 입력: topic(주제 1줄) + country(KR/JP/US)
 */
function buildPrompt({ topic, country }) {
  const presets = {
    KR: {
      label: "KR",
      lang: "ko",
      tone: "차분하고 사실 중심의 공영방송 뉴스 톤",
      thumbnailStyle: "짧고 단정, 과장 없음",
    },
    JP: {
      label: "JP",
      lang: "ja",
      tone: "절제된 NHK 해설 톤",
      thumbnailStyle: "정보 중심, 과장 없음",
    },
    US: {
      label: "US",
      lang: "en",
      tone: "PBS/NPR 스타일의 차분한 해설 톤",
      thumbnailStyle: "명확한 요지, 과장 없음",
    },
  };

  const p = presets[(country || "KR").toUpperCase()] || presets.KR;

  // 결과는 text로 반환될 것이므로, 구조를 매우 명확히 강제
  return `
You are a senior-focused economic news briefing producer.

HARD RULES (must follow):
- Audience: seniors
- Tone: ${p.tone}
- No exaggeration. No fear-mongering.
- No investment advice. No buy/sell/hold recommendations.
- Output MUST be in the exact JSON schema below. Do not add extra keys.
- Write in language: ${p.lang}

TOPIC (one line):
${topic}

OUTPUT JSON SCHEMA (EXACT):
{
  "longform": {
    "title": "string",
    "script": "string"
  },
  "shortforms": [
    { "title": "string", "script": "string" },
    { "title": "string", "script": "string" },
    { "title": "string", "script": "string" }
  ],
  "thumbnails": [
    { "text": "string", "recommended": true },
    { "text": "string", "recommended": false },
    { "text": "string", "recommended": false }
  ]
}

Thumbnail writing style: ${p.thumbnailStyle}

Longform requirements:
- 8 to 12 minutes worth of script (spoken)
- Must include: what happened, why it matters, impact on seniors, one neutral judgment point (no action command)

Shorts requirements:
- 3 scripts, each 30 to 50 seconds (spoken)
- S1: one-line summary focus
- S2: senior impact focus
- S3: caution/watch point focus

Return ONLY the JSON.`;
}

/**
 * 공통 실행 핸들러
 *
 * 안정성 원칙:
 * 1) 기존 응답 { ok, text } 유지 (web-ui 깨짐 방지)
 * 2) 추가로 result를 항상 제공 (롱1+숏3+썸3 고정)
 * 3) 실패 시 errorCode 고정 제공 (UI 1줄 처리 가능)
 */
async function handleExecute(req, res) {
  try {
    if (typeof fetch !== "function") {
      return res
        .status(500)
        .json(errorPayload("E-FETCH-NOT-FOUND", "Runtime fetch() not available. Use Node 18+."));
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json(errorPayload("E-NO-OPENAI-KEY", "MISSING_OPENAI_API_KEY"));
    }

    const { prompt, mode, country, language } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json(errorPayload("E-INVALID-PROMPT", "INVALID_PROMPT"));
    }

    // ✅ 최적안(B): 옵션 1개(country)만으로 내부 판단 기준 고정
    const composedPrompt = buildPrompt({
      topic: prompt,
      country: (country || "KR").toUpperCase(),
    });

    const modeTag = mode || "default";
    const cTag = (country || "KR").toUpperCase();
    const lTag = language || ""; // 참고용(미사용 가능)

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: `MODE:${modeTag}\nCOUNTRY:${cTag}\nLANG:${lTag}\n\n${composedPrompt}`,
          },
        ],
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      return res
        .status(r.status)
        .json(errorPayload("E-OPENAI-CALL-FAILED", `status=${r.status} body=${text.slice(0, 1200)}`));
    }

    const data = await r.json();
    const outText = extractOutputText(data);

    // ✅ 스키마 고정 result 제공(현재는 URL 생성 전 단계라 빈값 유지)
    const result = buildFixedResult();

    return res.json({
      ok: true,
      // 기존 호환: text 유지 (여기에 JSON 문자열이 들어올 것)
      text: outText || "",
      // (A) 고정 출력 포맷(틀)
      result,
      errorCode: null,
    });
  } catch (e) {
    return res.status(500).json(errorPayload("E-SERVER-ERROR", String(e?.message || e)));
  }
}

/**
 * web-ui가 호출하는 경로 (기존 코드가 /execute를 씀)
 */
app.post("/execute", handleExecute);

/**
 * 우리가 표준으로 쓰는 경로
 */
app.post("/api/execute", handleExecute);

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`[finishflow-live] listening on ${port}`));
