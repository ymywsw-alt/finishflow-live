import express from "express";
import { makeVideo, getDownloadPathByToken } from "./make.js";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

// health
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// root
app.get("/", (req, res) => {
  res
    .status(200)
    .send("FinishFlow OK. Use /health, POST /make, GET /download?token=...");
});

// make
app.post("/make", async (req, res) => {
  try {
    const topic = (req.body?.topic || "").toString().trim();
    if (!topic) {
      return res.status(400).json({ ok: false, error: "topic is required" });
    }

    const result = await makeVideo({ topic });

    // download_url은 “절대경로”로 주는 게 테스트에 유리
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    return res.status(200).json({
      ...result,
      download_url: `${baseUrl}${result.download_url}`
    });
  } catch (err) {
    console.error("[/make] error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "internal error"
    });
  }
});

// download
app.get("/download", (req, res) => {
  try {
    const token = (req.query?.token || "").toString().trim();
    if (!token) return res.status(400).send("token is required");

    const filePath = getDownloadPathByToken(token);
    if (!filePath) return res.status(404).send("invalid or expired token");
    if (!fs.existsSync(filePath)) return res.status(404).send("file missing");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="finishflow-${token}.mp4"`
    );

    const stream = fs.createReadStream(filePath);
    stream.on("error", (e) => {
      console.error("[/download] stream error:", e);
      res.status(500).send("stream error");
    });
    stream.pipe(res);
  } catch (err) {
    console.error("[/download] error:", err);
    res.status(500).send("internal error");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FinishFlow listening on ${PORT}`);
});
