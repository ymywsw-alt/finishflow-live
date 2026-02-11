// server.js (ESM)
// finishflow-live: /make runs make.js and returns its JSON
// /download serves generated mp4 by token (= id)

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";

const app = express();

app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.status(200).send("finishflow-live ok");
});

// ========================
// POST /make
// ========================
app.post("/make", (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid JSON body (empty)" });
    }
    if (typeof req.body.topic !== "string" || !req.body.topic.trim()) {
      return res.status(400).json({ ok: false, error: "Missing topic in JSON body" });
    }

    try {
      fs.writeFileSync("req.json", JSON.stringify(req.body, null, 2));
    } catch (_) {}

    exec("node make.js", { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      const out = String(stdout || "").trim();
      const err = String(stderr || "").trim();

      try {
        const parsed = JSON.parse(out);
        return res.status(200).json(parsed);
      } catch (_) {}

      const lastLine =
        out
          .split("\n")
          .map(s => s.trim())
          .filter(Boolean)
          .pop() || "";

      try {
        const parsed2 = JSON.parse(lastLine);
        return res.status(200).json(parsed2);
      } catch (_) {}

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
// ========================
app.get("/download", (req, res) => {
  try {
    const token = String(req.query.token || "").trim();

    if (!/^[a-f0-9]{8,40}$/i.test(token)) {
      return res.status(400).send("Invalid token");
    }

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("finishflow-live listening on port", PORT);
});
