import express from "express";
import { make } from "./make.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/make", async (req, res) => {
  try {
    const topic = (req.body?.topic || "").trim();
    if (!topic) {
      return res.status(400).json({ ok: false, error: "topic_required" });
    }

    const result = await make(topic);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`FinishFlow listening on ${port}`);
});
