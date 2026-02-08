const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => res.json({ ok: true, service: "finishflow-live" }));

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    service: "finishflow-live",
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    keyPrefix: process.env.OPENAI_API_KEY ? String(process.env.OPENAI_API_KEY).slice(0, 7) : null,
    now: new Date().toISOString()
  });
});

const REQ_JSON_PATH = path.join(process.cwd(), "req.json");
let isRunning = false;

// ✅ server.js가 소유하는 토큰 저장소
const tokenStore = new Map(); // token -> { filePath, expiresAt }
const TTL_MS = 30 * 60 * 1000;

function issueToken(filePath) {
  const token = crypto.randomBytes(12).toString("hex");
  tokenStore.set(token, { filePath, expiresAt: Date.now() + TTL_MS });

  // cleanup
  for (const [k, v] of tokenStore.entries()) {
    if (v.expiresAt < Date.now()) tokenStore.delete(k);
  }
  return token;
}

function getFilePath(token) {
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

function runMakeJs() {
  return new Promise((resolve) => {
    const child = spawn("node", ["make.js"], { cwd: process.cwd(), env: process.env });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      let parsed = null;
      try {
        const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i];
          if (l.startsWith("{") && l.endsWith("}")) {
            parsed = JSON.parse(l);
            break;
          }
        }
      } catch (_) {}
      resolve({ ok: code === 0, code, parsed, stdout, stderr });
    });
  });
}

// ✅ 브라우저 다운로드 라우트
app.get("/download", (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(400).send("Missing token");

  const filePath = getFilePath(token);
  if (!filePath) return res.status(404).send("Token not found or expired");
  if (!fs.existsSync(filePath)) return res.status(404).send("File not found on server");

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="finishflow-${token}.mp4"`);
  return res.sendFile(filePath);
});

app.post("/make", async (req, res) => {
  if (isRunning) return res.status(429).json({ ok: false, error: "Busy" });

  const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : "";
  const videoType = typeof req.body?.videoType === "string" ? req.body.videoType : "LONG";
  const topicTone = typeof req.body?.topicTone === "string" ? req.body.topicTone : "CALM";
  const durationSec =
    typeof req.body?.durationSec === "number" && Number.isFinite(req.body.durationSec) ? req.body.durationSec : 900;

  if (!topic) return res.status(400).json({ ok: false, error: "Missing topic" });

  try {
    isRunning = true;
    writeReqJson({ topic, videoType, topicTone, durationSec });

    const r = await runMakeJs();

    // ✅ make.js 결과에서 video_path만 사용 (make.js의 download_url은 무시)
    let serverDownloadUrl = null;
    if (r?.parsed?.video_path) {
      const token = issueToken(r.parsed.video_path);
      serverDownloadUrl = `/download?token=${token}`;
    }

    return res.json({
      ok: r.ok,
      route: "/make",
      result: {
        code: r.code,
        parsed: r.parsed,
        // ✅ 여기! 이 값만 써야 함
        download_url: serverDownloadUrl
      },
      logs: { stdout: r.stdout, stderr: r.stderr }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  } finally {
    isRunning = false;
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`finishflow-live listening on ${PORT}`));
