import express from "express";
import fs from "node:fs";
import { exec } from "node:child_process";

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  return res.status(200).json({ ok: true, service: "finishflow-live" });
});

app.get("/debug/env", (req, res) => {
  return res.status(200).json({
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    now: new Date().toISOString(),
  });
});

app.post("/make", (req, res) => {
  try {
    // Body 검증
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid JSON body (empty)" });
    }
    if (typeof req.body.topic !== "string" || !req.body.topic.trim()) {
      return res.status(400).json({ ok: false, error: "Missing topic in JSON body" });
    }

    // req.json 저장
    fs.writeFileSync("req.json", JSON.stringify(req.body, null, 2));

    // make.js 실행
    exec("node make.js", { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      const out = String(stdout || "").trim();
      const err = String(stderr || "").trim();

      // 1차: 전체 stdout JSON 파싱
      try {
        const parsed = JSON.parse(out);
        return res.status(200).json(parsed);
      } catch (_) {}

      // 2차: 마지막 줄 JSON 파싱
      const lastLine = out.split("\n").map(s => s.trim()).filter(Boolean).pop() || "";
      try {
        const parsed2 = JSON.parse(lastLine);
        return res.status(200).json(parsed2);
      } catch (_) {}

      // 실패 시 tail 반환
      return res.status(200).json({
        ok: false,
        error: error?.message || "make.js output not JSON",
        stdout_tail: out.slice(-2000),
        stderr_tail: err.slice(-2000),
      });
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

// JSON 파싱 실패 시 HTML 400 대신 JSON으로 반환
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
