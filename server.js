import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(express.static("public")); // UI 파일 serving

// ✅ 브라우저가 호출하는 유일한 API
app.post("/make", async (req, res) => {
  try {
    const response = await fetch(
      "https://finishflow-live-1.onrender.com/make",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "ENGINE_CALL_FAILED" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("FinishFlow Web UI running on port", PORT);
});
