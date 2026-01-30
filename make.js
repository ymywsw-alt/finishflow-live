import express from "express";
import cors from "cors";
import { make } from "./make.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const ROLE = process.env.ROLE || "gateway"; // "gateway" | "worker"
const WORKER_URL = process.env.WORKER_URL;  // gateway에서만 필요

// 공통 헬스체크
app.get("/health", (req, res) => res.json({ ok: true, role: ROLE }));

/**
 * WORKER 역할:
 * - /make를 직접 수행 (TTS + ffmpeg)
 * - 결과를 "mp4 바이너리"로 반환
 */
if (ROLE === "worker") {
  app.post("/make", async (req, res) => {
    try {
      const topic = String(req.body?.topic || "").trim();
      if (!topic) return res.status(400).json({ ok: false, error: "topic required" });

      // make()는 mp4 생성까지 수행하도록 이미 구성되어 있어야 함
      // (현재 make.js가 step4 mp4 생성 버전이어야 함)
      const result = await make(topic);

      // 워커는 결과 JSON만 돌려주는 대신, mp4를 바로 내려주는 것이 가장 단순/확실
      // make.js가 /tmp/final.mp4를 만든다는 전제
      const fs = await import("fs");
      const videoPath = "/tmp/final.mp4";

      if (!fs.existsSync(videoPath)) {
        return res.status(500).json({ ok: false, error: "final.mp4 not found" });
      }

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("X-FinishFlow-Step", String(result.step || 4));
      res.setHeader("X-FinishFlow-Topic", encodeURIComponent(topic));
      fs.createReadStream(videoPath).pipe(res);
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || "worker error" });
    }
  });
}

/**
 * GATEWAY 역할:
 * - /make 요청을 Worker로 프록시
 * - Worker가 돌려준 mp4 바이너리를 그대로 클라이언트에게 스트리밍
 */
if (ROLE === "gateway") {
  app.post("/make", async (req, res) => {
    try {
      if (!WORKER_URL) return res.status(500).json({ ok: false, error: "WORKER_URL missing" });

      const topic = String(req.body?.topic || "").trim();
      if (!topic) return res.status(400).json({ ok: false, error: "topic required" });

      const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/make`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });

      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return res.status(502).json({ ok: false, error: `worker ${r.status}`, detail: text.slice(0, 500) });
      }

      // worker는 video/mp4를 반환
      res.setHeader("Content-Type", "video/mp4");
      // worker가 주는 헤더(디버그용) 전달
      const step = r.headers.get("x-finishflow-step");
      const t = r.headers.get("x-finishflow-topic");
      if (step) res.setHeader("X-FinishFlow-Step", step);
      if (t) res.setHeader("X-FinishFlow-Topic", t);

      // 스트리밍 전달
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || "gateway error" });
    }
  });
}

app.listen(PORT, () => {
  console.log(`FinishFlow ${ROLE} listening on ${PORT}`);
});
