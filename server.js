const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { makeMp4 } = require("./make");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- in-memory file registry (token -> file path) ----
const files = new Map(); // token -> { filePath, createdAt }

function registerFile(filePath) {
  const token = crypto.randomBytes(16).toString("hex");
  files.set(token, { filePath, createdAt: Date.now() });
  return token;
}

function cleanupOldFiles() {
  const now = Date.now();
  for (const [token, v] of files.entries()) {
    // 20 minutes TTL
    if (now - v.createdAt > 20 * 60 * 1000) {
      try { fs.unlinkSync(v.filePath); } catch (_) {}
      files.delete(token);
    }
  }
}
setInterval(cleanupOldFiles, 60 * 1000).unref();

app.get("/", (req, res) => {
  res.status(200).type("text/plain").send("FinishFlow OK. Use /health, POST /make, GET /download?token=...");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * POST /make
 * body: { "topic": "..." }
 * response: { ok, step, topic, audio_generated, video_generated, video_path, download_url }
 */
app.post("/make", async (req, res) => {
  try {
    const topic = (req.body && req.body.topic ? String(req.body.topic) : "").trim();
    if (!topic) {
      return res.status(400).json({ ok: false, reason: "missing_topic" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, reason: "missing_OPENAI_API_KEY" });
    }

    const result = await makeMp4({ topic, apiKey });

    if (!result.ok) {
      // makeMp4 already includes reason + debug
      return res.status(500).json(result);
    }

    const token = registerFile(result.video_path);
    return res.json({
      ok: true,
      step: 4,
      topic,
      audio_generated: true,
      video_generated: true,
      video_path: result.video_path,
      download_url: `/download?token=${token}`
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      reason: "server_error",
      error: String(err && err.message ? err.message : err)
    });
  }
});

app.get("/download", (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!token || !files.has(token)) {
      return res.status(404).type("text/plain").send("Not found");
    }
    const { filePath } = files.get(token);

    if (!fs.existsSync(filePath)) {
      files.delete(token);
      return res.status(404).type("text/plain").send("Not found");
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="finishflow.mp4"`);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    stream.on("close", () => {
      // one-time download: remove file after served
      try { fs.unlinkSync(filePath); } catch (_) {}
      files.delete(token);
    });
  } catch (err) {
    return res.status(500).type("text/plain").send("Download error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FinishFlow listening on ${PORT}`);
});
