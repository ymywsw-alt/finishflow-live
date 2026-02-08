// finishflow-live / server.js  (FULL REPLACE)

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---- Basic health endpoints ----
app.get("/", (req, res) => {
  res.json({ ok: true, service: "finishflow-live", route: "server.js" });
});

app.get("/debug/env", (req, res) => {
  res.json({
    ok: true,
    service: "finishflow-live",
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    keyPrefix: process.env.OPENAI_API_KEY ? String(process.env.OPENAI_API_KEY).slice(0, 7) : null,
    now: new Date().toISOString()
  });
});

// ---- Helpers ----
const REQ_JSON_PATH = path.join(process.cwd(), "req.json");

// 동시에 2개 돌면 /tmp 파일, CPU, 메모리 충돌 가능 → 락
let isRunning = false;

// ✅ server.js(상주 프로세스)에 토큰 저장소를 둔다 (make.js 프로세스는 종료되므로 메모리 보존 불가)
const downloadTokenStore = new Map(); // token -> { filePath, expiresAt }
const TTL_MS = 30 * 60 * 1000; // 30 min

function putDownloadToken(token, filePath) {
  const expiresAt = Date.now() + TTL_MS;
  downloadTokenStore.set(token, { filePath, expiresAt });

  // best-effort cleanup
  for (const [k, v] of downloadTokenStore.entries()) {
    if (v.expiresAt < Date.now()) downloadTokenStore.delete(k);
  }
}

function getDownloadPath(token) {
  const v = downloadTokenStore.get(token);
  if (!v) return null;
  if (v.expiresAt < Date.now()) {
    downloadTokenStore.delete(token);
    return null;
  }
  return v.filePath;
}

function extractTokenFromDownloadUrl(downloadUrl) {
  // downloadUrl 예: "/download?token=abcd"
  if (!downloadUrl || typeof downloadUrl !== "string") return null;
  const idx = downloadUrl.indexOf("token=");
  if (idx === -1) return null;
  return downloadUrl.slice(idx + "token=".length).trim() || null;
}

function validateReq(body) {
  const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
  if (!topic) return { ok: false, error: "Missing required field: topic (string)" };

  const videoType = typeof body?.videoType === "string" ? body.videoType : "LONG";
  const topicTone = typeof body?.topicTone === "string" ? body.topicTone : "CALM";
  const durationSec =
    typeof body?.durationSec === "number" && Number.isFinite(body.durationSec)
      ? body.durationSec
      : 900;

  return { ok: true, req: { topic, videoType, topicTone, durationSec } };
}

function writeReqJson(reqObj) {
  fs.writeFileSync(REQ_JSON_PATH, JSON.stringify(reqObj, null, 2), "utf-8");
}

function runMakeJs() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["make.js"], {
      cwd: process.cwd(),
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      // make.js가 console.log(JSON.stringify(result))로 출력한 JSON을 파싱
      let parsed = null;
      try {
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i];
          if ((l.startsWith("{") && l.endsWith("}")) || (l.startsWith("[") && l.endsWith("]"))) {
            parsed = JSON.parse(l);
            break;
          }
        }
      } catch (_) {}

      resolve({ ok: code === 0, code, parsed, stdout, stderr });
    });
  });
}

// ✅ 다운로드 라우트 (브라우저 GET)
app.get("/download", (req, res) => {
  const token = (req.query.token || "").toString().trim();
  if (!token) {
    return res.status(400).send("Missing token");
  }

  const filePath = getDownloadPath(token);
  if (!filePath) {
    return res.status(404).send("Token not found or expired");
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found on server");
  }

  // mp4 다운로드 (브라우저 재생/다운로드 둘 다 가능)
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="finishflow-${token}.mp4"`);

  return res.sendFile(filePath);
});

// ---- SINGLE RUN: /make or /execute ----
app.post(["/make", "/execute"], async (req, res) => {
  if (isRunning) {
    return res.status(429).json({ ok: false, error: "Busy: job is already running." });
  }

  const v = validateReq(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  try {
    isRunning = true;
    writeReqJson(v.req);

    const result = await runMakeJs();

    // ✅ make.js 결과(parsed)에서 token + video_path를 server.js 메모리에 저장
    if (result?.parsed?.download_url && result?.parsed?.video_path) {
      const token = extractTokenFromDownloadUrl(result.parsed.download_url);
      if (token) putDownloadToken(token, result.parsed.video_path);
    }

    res.json({
      ok: result.ok,
      route: "/make",
      req: v.req,
      result: { code: result.code, parsed: result.parsed },
      logs: { stdout: result.stdout, stderr: result.stderr }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  } finally {
    isRunning = false;
  }
});

// ---- BATCH RUN: /batch (POST) ----
const TOPIC_POOL = {
  health: [
    "무릎 통증 줄이는 걷기 방법",
    "수면의 질 높이는 저녁 루틴",
    "혈압 안정에 도움 되는 식습관",
    "치매 예방을 위한 하루 10분 습관"
  ],
  money: [
    "노후 자금 지키는 지출 통제법",
    "연금 수령 전략에서 흔한 실수",
    "사기 피해를 막는 기본 점검 5가지"
  ],
  digital: [
    "카카오톡 꼭 해야 하는 설정 5가지",
    "스마트폰 사진 정리 한 번에 끝내기",
    "유튜브 글씨 크게 보는 방법"
  ]
};

function pickTopic(category, usedSet) {
  const list = TOPIC_POOL[category] || [];
  const candidates = list.filter((t) => !usedSet.has(t));
  const src = candidates.length ? candidates : list;
  const t = src[Math.floor(Math.random() * src.length)];
  usedSet.add(t);
  return t;
}

app.post("/batch", async (req, res) => {
  if (isRunning) {
    return res.status(429).json({ ok: false, error: "Busy: job is already running." });
  }

  const categories = [
    ...Array(4).fill("health"),
    ...Array(3).fill("money"),
    ...Array(3).fill("digital")
  ];

  const baseTone = typeof req.body?.topicTone === "string" ? req.body.topicTone : "CALM";
  const baseDurationSec =
    typeof req.body?.durationSec === "number" && Number.isFinite(req.body.durationSec)
      ? req.body.durationSec
      : 900;

  const used = new Set();
  const results = [];

  try {
    isRunning = true;

    for (let i = 0; i < categories.length; i++) {
      const category = categories[i];
      const topic = pickTopic(category, used);

      const oneReq = { topic, videoType: "LONG", topicTone: baseTone, durationSec: baseDurationSec };
      writeReqJson(oneReq);

      const r = await runMakeJs();

      // ✅ 배치에서도 token 저장
      if (r?.parsed?.download_url && r?.parsed?.video_path) {
        const token = extractTokenFromDownloadUrl(r.parsed.download_url);
        if (token) putDownloadToken(token, r.parsed.video_path);
      }

      results.push({
        idx: i + 1,
        category,
        req: oneReq,
        ok: r.ok,
        code: r.code,
        parsed: r.parsed,
        stderr_tail: (r.stderr || "").slice(-2000)
      });

      if (!r.ok) {
        return res.status(500).json({
          ok: false,
          stoppedAt: i + 1,
          error: "Batch stopped because a job failed (quality-first rule).",
          results
        });
      }
    }

    return res.json({ ok: true, count: results.length, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e), results });
  } finally {
    isRunning = false;
  }
});

// ---- Start ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`finishflow-live listening on ${PORT}`);
});
