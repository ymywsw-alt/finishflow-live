import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ✅ web-ui에서 직접 live를 때릴 수도 있으니, CORS는 "정확한 origin"만 허용
// (필요 없으면 아래 cors 미들웨어를 제거하고 web-ui 프록시만 쓰면 됨)
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/postman
      if (ALLOW_ORIGINS.length === 0) return cb(null, true); // 임시: 전체 허용(원하면 제거)
      if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true,
  })
);

// ✅ (4) 런타임 env 확인용 debug (실제 런타임 값 검증)
app.get("/debug/env", (req, res) => {
  const key = process.env.OPENAI_API_KEY || "";
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(key),
    keyPrefix: key ? key.slice(0, 7) : null, // "sk-...." 앞 7자만
    nodeEnv: process.env.NODE_ENV || null,
    service: "finishflow-live",
    now: new Date().toISOString(),
  });
});

// ✅ (1)(2) OpenAI 호출은 여기(live)에서만
app.post("/api/execute", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_OPENAI_API_KEY",
        hint: "Render finishflow-live runtime env에 OPENAI_API_KEY가 실제로 주입되어야 함",
      });
    }

    // 요청 payload는 web-ui가 넘겨주는 그대로 받되, 최소 검증만
    const { prompt, mode } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ ok: false, error: "INVALID_PROMPT" });
    }

    // ✅ Node18+ 내장 fetch 사용 (node-fetch 금지)
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
            content: `MODE:${mode || "default"}\n\n${prompt}`,
          },
        ],
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({
        ok: false,
        error: "OPENAI_CALL_FAILED",
        status: r.status,
        body: text.slice(0, 2000),
      });
    }

    const data = await r.json();

    // responses API 결과에서 텍스트를 안전하게 추출(최소형)
    let outText = "";
    try {
      const arr = data.output || [];
      const msg = arr.find((x) => x.type === "message");
      const content = msg?.content || [];
      const txt = content.find((c) => c.type === "output_text");
      outText = txt?.text || "";
    } catch {}

    return res.json({
      ok: true,
      text: outText || "",
      raw: process.env.RETURN_RAW === "1" ? data : undefined,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      message: String(e?.message || e),
    });
  }
});

// Render 포트
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`[finishflow-live] listening on ${port}`);
});
