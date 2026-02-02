import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing");
  process.exit(1);
}

app.post("/generate", async (req, res) => {
  try {
    const { prompt } = req.body;

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await r.json();

    if (!r.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json(data);
    }

    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/", (_, res) => {
  res.send("finishflow-live OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 server running on", PORT);
});
