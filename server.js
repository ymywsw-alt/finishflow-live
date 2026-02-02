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
 * OpenAI Responses API에서 output_text 뽑기 (기존 로직 유지 + 안전화)
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
 * - 안정성을 위해 URL이 없으면 ""로 유지
 * - 길이(3개)는 항상 고정
 */
function buildFixedResult({ longformUrl = "", longformDurationSec = 0, shortformUrls = [], shortformDurationsSec = [], thumbnailUrls = [] } = {}) {
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

/**
 * ✅ 에러를 UI가 1줄로 처리하기 쉽게: errorCode만 고정 제공
 * - (중요) HTTP status는 기존대로 두되, web-ui가 보기 쉬운 필드 제공
 */
function errorPayload(errorCode, detail) {
  return {
    ok: false,
    errorCode,
    // 기존 호환(기존 UI가 error를 보던 경우 대비)
    error: errorCode,
    // 개발용(너무 길면 잘라서)
    detail: detail ? String(detail).slice(0, 2000) : null,
    // 스키마 고정: 실패해도 항상 존재
    result: buildFixedResult(),
    // 기존 호환: text 유지
    text: "",
  };
}

/**
 * 공통 실행 핸들러
 *
 * 안정성 원칙:
 * 1) 기존 응답 { ok, text }는 유지 (web-ui 깨짐 방지)
 * 2) 추가로 result를 항상 제공 (롱1+숏3+썸3 고정)
 * 3) 실패 시 errorCode 고정 제공 (UI 1줄 처리 가능)
 */
async function handleExecute(req, res) {
  try {
    if (typeof fetch !== "function") {
      // Node 18+에서는 기본 fetch가 있어야 정상
      return res.status(500).json(errorPayload("E-FETCH-NOT-FOUND", "Runtime fetch() not available. Use Node 18+."));
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json(errorPayload("E-NO-OPENAI-KEY", "MISSING_OPENAI_API_KEY"));
    }

    const { prompt, mode, country, language } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json(errorPayload("E-INVALID-PROMPT", "INVALID_PROMPT"));
    }

    // (B)는 다음 단계에서 프리셋 테이블로 확정 적용할 거라,
    // 여기서는 입력만 안전하게 전달(현재 안정 최우선)
    const modeTag = mode || "default";
    const cTag = country || "KR";
    const lTag = language || "ko";

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
            content: `MODE:${modeTag}\nCOUNTRY:${cTag}\nLANG:${lTag}\n\n${prompt}`,
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

    /**
     * ✅ 스키마 고정 result 제공 (현재 단계에서는 URL 생성이 아직 없으므로 빈값)
     * - 추후 /make가 실제로 생성한 URL들을 여기 result에 채우는 구조로 확장
     */
    const result = buildFixedResult();

    // ✅ 기존 web-ui 호환: ok + text 유지
    return res.json({
      ok: true,
      text: outText || "",
      result,          // (A) 고정 출력 포맷
      errorCode: null, // 성공 시 null
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
