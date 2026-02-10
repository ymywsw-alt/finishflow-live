import express from "express";
import fs from "fs";
import { exec } from "child_process";

const app = express();

// 1) JSON 파서: limit 키우고, 에러를 JSON으로 반환하도록 준비
app.use(express.json({ limit: "2mb" }));

// 2) 루트/디버그
app.get("/", (req, res) => {
  res.json({ ok: true, service: "finishflow-live" });
});

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    now: new Date().toISOString(),
  });
});

// 3) make
app.post("/make", (req, res) => {
  try {
    // 바디가 안 들어오면 즉시 원인 반환
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid JSON body (req.body empty)" });
    }
    if (!req.body.topic) {
      return res.status(400).json({ ok: false, error: "Missing topic in JSON body" });
    }

    fs.writeFileSync("req.json", JSON.stringify(req.body, null, 2));

    exec("node make.js", { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        return res.status(200).json({
          ok: false,
          error: stderr || error.message || "make.js failed",
        });
      }

      // make.js가 JSON 한 줄 출력하도록 되어있으니 그대로 파싱
      try {
        const parsed = JSON.parse(stdout);
        return res.status(200).json(parsed);
      } catch (e) {
        return res.status(200).json({
          ok: false,
          error: "make.js output not JSON",
          stdout,
        });
      }
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

// 4) JSON 파싱 에러 핸들러 (이게 없으면 HTML 400이 뜸)
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({
      ok: false,
      error: "Bad JSON (parse failed)",
      detail: err.message,
    });
  }
  return res.status(500).json({ ok: false, error: err?.message || "Server error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("server running on port", port));
