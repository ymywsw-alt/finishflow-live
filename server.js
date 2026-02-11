// server.js (FULL REPLACE)
// finishflow-live: /make runs make.js and returns its JSON
// /download serves generated mp4 by token (= id)

const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const app = express();

// Render/Proxy 환경에서 body 파싱
app.use(express.json({ limit: "2mb" }));

// 간단 상태 확인용
app.get("/", (req, res) => {
  res.status(200).send("finishflow-live ok");
});

// ========================
// POST /make
// ========================
app.post("/make", (req, res) => {
  try {
    // Body 검증
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid JSON body (empty)" });
    }
    if (typeof req.body.topic !== "string" || !req.body.topic.trim()) {
      return res.status(400).json({ ok: false, error: "Missing topic in JSON body" });
    }

    // req.json 저장(디버깅용)
    try {
      fs.writeFileSync("req.json", JSON.stringify(req.body, null, 2));
    } catch (_) {}

    // make.js 실행
    exec("node make.js", { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      const out = String(stdout || "").trim();
      const err = String(stderr || "").trim();

      // 1차: 전체 stdout JSON 파싱 시도
      try {
        const parsed = JSON.parse(out);
        return res.status(200).json(parsed);
      } catch (_) {}

      // 2차: 마지막 줄 JSON 파싱 시도
      const lastLine = out
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean)
        .pop() || "";

      try {
        const parsed2 = JSON.parse(lastLine);
        return res.status(200).json(parsed2);
      } catch (_) {}

      // 실패: tail 반환
      return res.status(200).json({
        ok: false,
        error: (error && error.message) || "make.js output not JSON",
        stdout_tail: out.slice(-2000),
        stderr_tail: err.slice(-2000),
      });
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

// ========================
// GET /download?token=xxxx
// token == id (hex)
// file path: /app/out/<token>/<token>.mp4
// ========================
app.get("/download", (req, res) => {
  try {
    const token = String(req.query.token || "").trim();

    // token 안전 검증(경로 공격 방지)
    if (!/^[a-f0-9]{8,40}$/i.test(token)) {
      return res.status(400).send("Invalid token");
    }

    // Render 컨테이너 기준 경로
    const mp4Path = path.resolve("/app/out", token, `${token}.mp4`);

    if (!fs.existsSync(mp4Path)) {
      return res.status(404).send("File not found");
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${token}.mp4"`);

    return res.sendFile(mp4Path);
  } catch (e) {
    return res.status(500).send("Download error");
  }
});

// Render가 요구하는 PORT 바인딩
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("finishflow-live listening on port", PORT);
});
