import express from "express";
import fs from "fs";
import { exec } from "child_process";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, service: "finishflow-live" });
});

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    now: new Date().toISOString()
  });
});

app.post("/make", async (req, res) => {
  try {
    fs.writeFileSync("req.json", JSON.stringify(req.body, null, 2));

    exec("node make.js", (error, stdout, stderr) => {
      if (error) {
        return res.json({
          ok: false,
          error: stderr || error.message
        });
      }

      try {
        const parsed = JSON.parse(stdout);
        res.json(parsed);
      } catch {
        res.json({
          ok: false,
          error: stdout
        });
      }
    });

  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("server running on port", port);
});
