import express from "express";
import fs from "node:fs";
import { exec } from "node:child_process";

const app = express();

// JSON 바디 파싱 (400을 HTML로 내지 않고 JSON으로 처리하기 위해 아래 에러핸들러 포함)
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.status(200).json({ ok: true, service: "finishflow-live" });
});

app.get("/debug/env", (req, res) => {
  res.status(200).json({
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
    exec("node make.js", { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      // make.js 자체 실패
      if (error) {
        return res.status(200).json({
          ok: false,
          error: stderr || error.message || "make.js failed",
          stdout: String(stdout || "").trim(),
        });
      }

      // stdout에 로그가 섞여도 마지막 JSON만 파싱
      const s = String(stdout || "").trim();

let picked = null;

for (let i = 0; i < s.length; i++) {
  if (s[i] !== "{") continue;

  const sub = s.slice(i);
  try {
    const obj = JSON.parse(sub);
    if (obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, "ok")) {
      picked = obj;
    }
  } catch (_) {}
}

if (picked) return res.status(200).json(picked);

return res.status(200).json({
  ok: false,
  error: "no {ok:...} JSON found in make.js stdout",
  stdout: s,
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
