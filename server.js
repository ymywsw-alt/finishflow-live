/**
 * finishflow-live/server.js (FULL REPLACE - ESM)
 * 역할: 엔진 API 게이트웨이
 * - GET  /health   : OK
 * - POST /execute  : worker로 프록시
 *
 * ENV (아무거나 하나만 있으면 됨)
 *   WORKER_URL = https://finishflow-worker.onrender.com
 *   FINISHFLOW_WORKER_URL = https://finishflow-worker.onrender.com
 */

import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 10000);

const WORKER_URL_RAW =
  process.env.WORKER_URL ||
  process.env.FINISHFLOW_WORKER_URL ||
  "https://finishflow-worker.onrender.com";

const WORKER_URL = WORKER_URL_RAW.toString().trim().replace(/\/$/, "");

// JSON 바디
app.use(express.json({ limit: "10mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "finishflow-live", worker: WORKER_URL, time: new Date().toISOString() });
});

app.post("/execute", async (req, res) => {
  try {
    const r = await fetch(`${WORKER_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });

    const text = await r.text();
    // worker가 JSON이든 텍스트든 그대로 전달
    res.status(r.status).type("application/json").send(text);
  } catch (e) {
    res.status(502).json({
      error: "Failed to reach worker /execute",
      worker: WORKER_URL,
      message: String(e?.message || e),
    });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: "Not Found" }));

app.listen(PORT, () => {
  console.log(`finishflow-live listening on ${PORT}`);
  console.log(`WORKER_URL=${WORKER_URL}`);
});
