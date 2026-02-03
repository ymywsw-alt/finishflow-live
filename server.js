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
 * ✅ 브라우저에서 클릭 한 번으로 POST /execute 테스트하는 페이지
 */
app.get("/test/execute", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h3>FinishFlow Live - POST /execute Test</h3>
    <p>이 페이지는 브라우저에서 테스트하기 위한 GET 페이지입니다. 실제 엔진은 POST /execute 입니다.</p>
    <label>Country:
      <select id="country">
        <option value="KR" selected>KR</option>
        <option value="JP">JP</option>
        <option value="US">US</option>
      </select>
    </label>
    <br/><br/>
    <label>Prompt (topic):</label><br/>
    <textarea id="prompt" rows="4" cols="70">오늘 환율 급등, 시니어 생활비 영향</textarea>
    <br/><br/>
    <button id="btn">Run POST /execute</button>
    <pre id="out" style="white-space:pre-wrap; border:1px solid #ddd; padding:10px; margin-top:12px;"></pre>
    <script>
      const btn = document.getElementById('btn');
      btn.onclick = async () => {
        const out = document.getElementById('out');
        out.textContent = "Running...";
        try {
          const prompt = document.getElementById('prompt').value;
          const country = document.getElementById('country').value;
          const r = await fetch('/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, country })
          });
          const j = await r.json();
          out.textContent = JSON.stringify(j, null, 2);
        } catch (e) {
          out.textContent = "ERROR: " + String(e);
        }
      };
    </script>
  `);
});

/**
 * ✅ 고정 결과 스키마: 롱폼1 + 숏폼3 + 썸네일3(추천1)
 */
function emptyFixedResult() {
  return {
    longform: { title: "", script: "" },
    shortforms: [
      { title: "", script: "" },
      { title: "", script: "" },
      { title: "", script: "" },
    ],
    thumbnails: [
      { text: "", recommended: true },
      { text: "", recommended: false },
      { text: "", recommended: false },
    ],
  };
}

function errorPayload(errorCode, detail) {
  return {
    ok: false,
    errorCode,
    error: errorCode,
    detail: detail ? String(detail).slice(0, 2000) : null,
    result: emptyFixedResult(),
    text: "작업 실패 – 잠시 후 다시 시도해주세요.",
  };
}

/**
 * OpenAI Responses API에서 output_text 뽑기
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
 * ✅ 모델이 가끔 ```json ... ``` 로 감싸거나 앞뒤에 말 붙이는 경우가 있음
 * 그래서 "JSON만" 남기도록 정리한 뒤 parse 한다.
 */
function coerceToJsonString(raw) {
  if (!raw) return "";

  let s = String(raw).trim();

  // 1) ```json ... ``` 또는 ``` ... ``` 코드펜스 제거
  // 시작이 ``` 로 시작하면 첫 줄 제거
  if (s.startsWith("```")) {
    // 첫 줄(```json or ```) 제거
    const firstNewline = s.indexOf("\n");
    if (firstNewline !== -1) s = s.slice(firstNewline + 1);
    // 끝의 ``` 제거
    const lastFence = s.lastIndexOf("```");
    if (lastFence !== -1) s = s.slice(0, lastFence);
    s = s.trim();
  }

  // 2) 그래도 앞뒤에 텍스트가 섞이면, 첫 '{' ~ 마지막 '}'만 추출
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1).trim();
  }

  return s;
}

/**
 * 국가/언어 옵션 1개로 프롬프트 자동 조립
 */
function buildPrompt({ topic, country }) {
  const presets = {
    KR: {
      lang: "ko",
      tone: "차분하고 사실 중심의 공영방송 뉴스 톤",
      thumbnailStyle: "짧고 단정, 과장 없음",
    },
    JP: {
      lang: "ja",
      tone: "절제된 NHK 해설 톤",
      thumbnailStyle: "정보 중심, 과장 없음",
    },
    US: {
      lang: "en",
      tone: "PBS/NPR 스타일의 차분한 해설 톤",
      thumbnailStyle: "명확한 요지, 과장 없음",
    },
  };

  const p = presets[(country || "KR").toUpperCase()] || presets.KR;

  return `
You are a senior-focused economic news briefing producer.

HARD RULES (must follow):
- Audience: seniors
- Tone: ${p.tone}
- No exaggeration. No fear-mongering.
- No investment advice. No buy/sell/hold recommendations.
- Output MUST be valid JSON and MUST match the exact schema.
- Do NOT wrap the JSON in markdown fences (no \`\`\`).
- Return ONLY the JSON object, nothing else.
- Write in language: ${p.lang}

TOPIC:
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

Thumbnail style: ${p.thumbnailStyle}

Return ONLY the JSON.`;
}

/**
 * 파싱 결과를 스키마로 강제 고정
 */
function normalizeParsedResult(parsed) {
  const base = emptyFixedResult();

  const lf = parsed?.longform || {};
  base.longform.title = typeof lf.title === "string" ? lf.title : "";
  base.longform.script = typeof lf.script === "string" ? lf.script : "";

  const sf = Array.isArray(parsed?.shortforms) ? parsed.shortforms : [];
  for (let i = 0; i < 3; i++) {
    const item = sf[i] || {};
    base.shortforms[i].title = typeof item.title === "string" ? item.title : "";
    base.shortforms[i].script = typeof item.script === "string" ? item.script : "";
  }

  const th = Array.isArray(parsed?.thumbnails) ? parsed.thumbnails : [];
  for (let i = 0; i < 3; i++) {
    const item = th[i] || {};
    base.thumbnails[i].text = typeof item.text === "string" ? item.text : "";
    base.thumbnails[i].recommended = i === 0; // 추천 1개 고정
  }

  return base;
}

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

    const composedPrompt = buildPrompt({
      topic: prompt,
      country: (country || "KR").toUpperCase(),
    });

    const modeTag = mode || "default";
    const cTag = (country || "KR").toUpperCase();
    const lTag = language || "";

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

    // ✅ 코드펜스/잡텍스트 제거 후 JSON.parse
    const jsonString = coerceToJsonString(outText);
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (e) {
      return res.status(200).json(
        errorPayload("E-PARSE-001", `JSON.parse failed: ${String(e?.message || e)} | head=${jsonString.slice(0, 120)}`)
      );
    }

    const result = normalizeParsedResult(parsed);

    return res.json({
      ok: true,
      text: "완료 – 롱폼 1 + 숏폼 3 + 썸네일 3 생성",
      result,
      errorCode: null,
    });
  } catch (e) {
    return res.status(500).json(errorPayload("E-SERVER-ERROR", String(e?.message || e)));
  }
}

app.post("/execute", handleExecute);
app.post("/api/execute", handleExecute);

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`[finishflow-live] listening on ${port}`));
