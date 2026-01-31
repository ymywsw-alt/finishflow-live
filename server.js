const express = require("express");
const { makeVideoJob, getDownloadByToken } = require("./make");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res
    .status(200)
    .send("FinishFlow OK. Use /health, POST /make, GET /download?token=...");
});

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /make
 * body: { topic: "..." }
 */
app.post("/make", async (req, res) => {
  try {
    const topic = (req.body?.topic || "").toString().trim();
    if (!topic) return res.status(400).json({ ok: false, error: "missing topic" });

    const result = await makeVideoJob({ topic, req });
    res.json(result);
  } catch (err) {
    console.error("[/make] ERROR:", err?.stack || err);
    res.status(500).json({
      ok: false,
      error: "internal_error",
      detail: String(err?.message || err)
    });
  }
});

/**
 * GET /download?token=...
 * Streams mp4
 */
app.get("/download", async (req, res) => {
  try {
    const token = (req.query?.token || "").toString().trim();
    if (!token) return res.status(400).send("missing token");

    const info = await getDownloadByToken(token);
    if (!info) return res.status(404).send("invalid token");

    // mp4 스트리밍
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="finishflow.mp4"`);

    info.stream.pipe(res);
    info.stream.on("error", (e) => {
      console.error("[/download] stream error:", e);
      if (!res.headersSent) res.status(500).end("stream error");
      else res.end();
    });
  } catch (err) {
    console.error("[/download] ERROR:", err?.stack || err);
    res.status(500).send("internal_error");
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`FinishFlow listening on ${port}`);
});
