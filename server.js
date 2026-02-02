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
 * 공통 실행 핸들러
 */
async function handleExecute(req, res) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_OPENAI_API_KEY",
      });
    }

    const { prompt, mode } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ ok: false, error: "INVALID_PROMPT" });
    }

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

    let outText = "";
    try {
      const arr = data.output || [];
      const msg = arr.find((x) => x.type === "message");
      const content = msg?.content || [];
      const txt = content.find((c) => c.type === "output_text");
      outText = txt?.text || "";
    } catch {}

    return res.json({ ok: true, text: outText || "" });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      message: String(e?.message || e),
    });
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
