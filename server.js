/**
 * FinishFlow Engine - server.js (FULL REPLACE, ESM)
 * - JSON 파싱으로 절대 500 안 터지게 설계
 * - 빈/깨진 body는 400으로 종료
 * - /health, /execute, /api/execute 지원
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---- path helpers (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- app
const app = express();
const PORT = Number(process.env.PORT || 10000);
const MAX_BODY = process.env.MAX_BODY || "50mb";

// ---- CORS (전체 허용, 디버깅 최우선)
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

/**
 * ❗ 핵심 설계
 * express.json() 사용 ❌
 * → text로 받은 뒤 수동 JSON.parse
 * → Render에서 발생한 JSON.parse 즉사 500 원천 차단
 */
app.use(
  express.text({
    type: "*/*",
    limit: MAX_BODY,
  })
);

// ---- safe JSON parser
function parseJsonBody(req) {
  const raw = req.body;

  const text =
    raw === undefined || raw === null
      ? ""
      : typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : String(raw);

  if (text.trim().length === 0) return null;

  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error("Invalid JSON body");
    e.statusCode = 400;
    e.details = err?.message || String(err);
    e.preview = text.slice(0, 200);
    throw e;
  }
}

// ---- load make.js safely
let runner = null;
try {
  const mod = await import(path.join(__dirname, "make.js"));
  runner =
    typeof mod.default === "function"
      ? mod.default
      : typeof mod.run === "function"
      ? mod.run
      : typeof mod.execute === "function"
      ? mod.execute
      : null;
} catch (e) {
  runner = null;
}

// ---- health
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "finishflow-live",
    time: new Date().toISOString(),
  });
});

// ---- execute handler
async function handleExecute(req, res) {
  // 1) parse body safely
  let payload;
  try {
    payload = parseJsonBody(req);
  } catch (e) {
    return res.status(e.statusCode || 400).json({
      error: e.message,
      details: e.details || null,
      preview: e.preview || null,
    });
  }

  // 2) guard empty body
  if (!payload || (typeof payload === "object" && Object.keys(payload).length === 0)) {
    return res.status(400).json({
      error: "Invalid or empty JSON body",
    });
  }

  // 3) runner check
  if (!runner) {
    return res.status(500).json({
      error: "Engine runner not found (make.js)",
    });
  }

  // 4) execute pipeline
  try {
    const result = await runner(payload);
    return res.status(200).json({
      ok: true,
      result,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Engine execution failed",
      message: err?.message || String(err),
    });
  }
}

// ---- routes
app.post("/execute", handleExecute);
app.post("/api/execute", handleExecute);

// ---- 404
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// ---- final error guard
app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({
    error: err.message || "Server error",
  });
});

// ---- start
app.listen(PORT, () => {
  console.log(`FinishFlow listening on ${PORT}`);
});
