// finishflow-live / server.js  (FULL REPLACE)

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---- Basic ----
app.get("/", (req, res) => {
  res.json({ ok: true, service: "finishflow-live", route: "server.js" });
});

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    service: "finishflow-live",
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    keyPrefix: process.env.OPENAI_API_KEY ? String(process.env.OPENAI_API_KEY).slice(0, 7) : null,
    now: new Date().toISOString()
  });
});

// ---- State ----
const REQ_JSON_PATH = path.join(process.cwd(), "req.json");
let isRunning = false;

// ✅ server.js(상주)에 토큰 저장
const tokenStore = new Map(); // token -> { filePath, expiresAt }
const TTL_MS = 30 * 60 * 1000; // 30 minutes

function putToken(filePath) {
  const token = crypto.randomBytes(12).toString("hex");
  const expiresAt = Date.now() + TTL_MS;
  tokenStore.set(token, { filePath, expiresAt });

  // cleanup
  for (const [k, v] of tokenStore.entries()) {
    if (v.expiresAt < Date.now()) tokenStore.delete(k);
  }
  return token;
}

function getPathByToken(token) {
  const v = tokenStore.get(token);
  if (!v) return null;
  if (v.expiresAt < Date.now()) {
    tokenStore.delete(token);
    return null;
  }
  return v.filePath;
}

function writeReqJson(reqObj) {
  fs.writeFileSync(REQ_JSON_PATH, JSON.stringify(reqObj, null, 2), "utf-8");
}

function validateReq(body) {
  const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
  if (!topic) return { ok: false, error: "Missing required field: topic (string)" };

  const videoType = typeof body?.videoType === "string" ? body.videoType : "LONG";
  const topicTone = typeof body?.topicTone === "string" ? body.topicTone : "CALM";
  const durationSec =
    typeof body?.durationSec === "number" && Number.isFinite(body.durationSec)
      ? body.durationSec
      : 900;

  return { ok: true, req: { topic, videoType, topicTone, durationSec } };
}

function runMakeJs() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["make.js"], { cwd: process.cwd(), env: process.env });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      let parsed = null;
      try {
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

        // 마지막 JSON 라인 파싱 시도
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i];
          if ((l.startsWith("{") && l.endsWith("}")) || (l.startsWith("[") && l.endsWith("]"))) {
            parsed = JSON.parse(l);
            break;
          }
        }
      } catch (_) {}

      resolve({ ok: code === 0, code, parsed, stdout, stderr });
    });
  });
}

// ✅ 다운로드 (브라우저 GET)
app.get("/download", (req, res) => {
  const token = (req.query.token || "").toString().trim();
  if (!token) return res.status(400).send("Missing token");

  const filePath = getPathByToken(token);
  if (!filePath) return res.status(404).send("Token not found or expired");

  if (!fs.existsSync(filePath)) return res.status(404).send("File not found on server");

  res.setHeader("Content-Type", "video/mp4");
  // 다운로드/저장 되게 (원하면 inline으로 바꿀 수 있음)
  res.setHeader("Content-Disposition", `attachment; filename="finishflow-${token}.mp4"`);
  return res.sendFile(filePath);
});

// ---- SINGLE RUN: /make or /execute ----
app.post(["/make", "/execute"], async (req, res) => {
  if (isRunning) return res.status(429).json({ ok: false, error: "Busy: job is already running." });

  const v = validateReq(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  try {
    isRunning = true;
    writeReqJson(v.req);

    const r = await runMakeJs();

    // ✅ make.js 결과에서 video_path만 쓰고, 토큰은 server.js가 새로 발급
    let download_url = null;
    if (r?.parsed?.video_path && typeof r.parsed.video_path === "string") {
      const token = putToken(r.parsed.video_path);
      download_url = `/download?token=${token}`;
    }

    return res.json({
      ok: r.ok,
      route: "/make",
      req: v.req,
      result: {
        code: r.code,
        parsed: r.parsed,
        // ✅ 서버가 발급한 다운로드 URL
        download_url
      },
      logs: { stdout: r.stdout, stderr: r.stderr }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  } finally {
    isRunning = false;
  }
});

// ---- Start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`finishflow-live listening on ${PORT}`);
});
