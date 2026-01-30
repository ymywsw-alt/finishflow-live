import express from "express";
import { makeVideo } from "./make.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// 홈: 현재 서버가 무엇인지 보여주는 최소 화면
app.get("/", (req, res) => {
  res
    .status(200)
    .type("html")
    .send(`
      <h2>FinishFlow (single service)</h2>
      <p>POST /make  {"topic":"..."}  → generate mp4</p>
      <p>GET  /health → {"ok":true}</p>
      <p>GET  /download → download latest mp4</p>
    `);
});

// 헬스체크
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// 생성 API
app.post("/make", async (req, res) => {
  try {
    const topic = (req.body?.topic || "").toString().trim();
    if (!topic) {
      return res.status(400).json({ ok: false, error: "topic is required" });
    }

    const result = await makeVideo({ topic });

    return res.json({
      ok: true,
      step: result.step,
      topic: result.topic,
      audio_generated: result.audio_generated,
      video_generated: result.video_generated,
      video_path: result.video_path,
      // Render에서 접근 가능한 다운로드 URL (최신 1개 파일)
      download_url: "/download"
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err)
    });
  }
});

// 최신 결과 mp4 다운로드
app.get("/download", (req, res) => {
  const filePath = "/tmp/final.mp4";
  // 파일이 없으면 404
  res.download(filePath, "finishflow.mp4", (err) => {
    if (err) {
      res.status(404).send("No file. Call POST /make first.");
    }
  });
});

// Render는 PORT 환경변수 사용
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FinishFlow listening on ${PORT}`);
});
