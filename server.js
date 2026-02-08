// finishflow-live / server.js  (FULL REPLACE)

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "5mb" }));

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

// 간단 락: 동시에 make.js가 2번 돌면 req.json 충돌/리소스 충돌 가능 → 막는다.
let isRunning = false;

function validateReq(body) {
  // 최소 필수: topic (문자열)
  const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
  if (!topic) return { ok: false, error: "Missing required field: topic (string)" };

  // 선택 필드 기본값
  const videoType = typeof body?.videoType === "string" ? body.videoType : "LONG";
  const topicTone = typeof body?.topicTone === "string" ? body.topicTone : "CALM";
  const durationSec =
    typeof body?.durationSec === "number" && Number.isFinite(body.durationSec)
      ? body.durationSec
      : 900;

  return {
    ok: true,
    req: { topic, videoType, topicTone, durationSec }
  };
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
      // make.js가 JSON을 stdout으로 찍는 경우를 최대한 살린다.
      // 마지막 JSON 객체/배열 라인을 파싱 시도
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

      resolve({
        ok: code === 0,
        code,
        parsed, // make.js가 마지막에 JSON 출력하면 여기에 잡힘
        stdout,
        stderr
      });
    });
  });
}

// ---- SINGLE RUN: 1회 생성 ----
// web-ui는 기존대로 /make 또는 /execute를 칠 가능성이 높아서 둘 다 제공
app.post(["/make", "/execute"], async (req, res) => {
  if (isRunning) {
    return res.status(429).json({
      ok: false,
      error: "Busy: a generation job is already running. Try again in a moment."
    });
  }

  const v = validateReq(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  try {
    isRunning = true;
    writeReqJson(v.req);

    const result = await runMakeJs();

    // 성공/실패 여부 + 로그 + 파싱된 결과(있으면)
    res.json({
      ok: result.ok,
      route: "/make",
      req: v.req,
      result: {
        code: result.code,
        parsed: result.parsed
      },
      // 로그는 길 수 있으니 필요하면 줄여도 됨. 지금은 디버깅 우선으로 그대로 반환.
      logs: {
        stdout: result.stdout,
        stderr: result.stderr
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  } finally {
    isRunning = false;
  }
});

// ---- BATCH RUN: 1회 실행 → 10세트 ----
// 카테고리 비율 고정: 건강4 / 돈3 / 디지털3
// 지금 단계에서는 "주제 생성 로직"을 간단 내장 풀로 두고, 다음 단계에서 GPT 생성/게이트로 강화
const TOPIC_POOL = {
  health: [
    "무릎 통증 줄이는 걷기 방법",
    "수면의 질 높이는 저녁 루틴",
    "혈압 안정에 도움 되는 식습관",
    "치매 예방을 위한 하루 10분 습관",
    "허리 부담 줄이는 스트레칭",
    "관절에 좋은 근력운동 시작법"
  ],
  money: [
    "노후 자금 지키는 지출 통제법",
    "연금 수령 전략에서 흔한 실수",
    "사기 피해를 막는 기본 점검 5가지",
    "자녀 부담 줄이는 재무 정리 순서",
    "통장 관리 한 번에 끝내는 방법"
  ],
  digital: [
    "카카오톡 꼭 해야 하는 설정 5가지",
    "스마트폰 사진 정리 한 번에 끝내기",
    "유튜브 글씨 크게 보는 방법",
    "AI를 일상에 쓰는 가장 쉬운 방법",
    "모바일뱅킹 안전하게 쓰는 습관"
  ]
};

function pickTopic(category, usedSet) {
  const list = TOPIC_POOL[category] || [];
  // 중복 최소화: 아직 안쓴 것 우선
  const candidates = list.filter((t) => !usedSet.has(t));
  const target = (candidates.length ? candidates : list)[Math.floor(Math.random() * (candidates.length ? candidates : list).length)];
  usedSet.add(target);
  return target;
}

app.post("/batch", async (req, res) => {
  if (isRunning) {
    return res.status(429).json({
      ok: false,
      error: "Busy: a generation job is already running. Try again in a moment."
    });
  }

  // 배치 기본값: 10세트 고정
  const categories = [
    ...Array(4).fill("health"),
    ...Array(3).fill("money"),
    ...Array(3).fill("digital")
  ];

  // 공통 옵션 (요청에서 override 가능)
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

      const oneReq = {
        topic,
        videoType: "LONG",
        topicTone: baseTone,
        durationSec: baseDurationSec
      };

      writeReqJson(oneReq);

      const r = await runMakeJs();

      results.push({
        idx: i + 1,
        category,
        req: oneReq,
        ok: r.ok,
        code: r.code,
        parsed: r.parsed,
        // 실패 원인 추적을 위해 stderr 핵심만 같이 보냄
        stderr_tail: (r.stderr || "").slice(-2000)
      });

      // 하나라도 실패하면 즉시 중단 (품질/신뢰 우선)
      if (!r.ok) {
        return res.status(500).json({
          ok: false,
          stoppedAt: i + 1,
          error: "Batch stopped because a job failed (quality-first rule).",
          results
        });
      }
    }

    return res.json({
      ok: true,
      count: results.length,
      results
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e), results });
  } finally {
    isRunning = false;
  }
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`finishflow-live listening on ${PORT}`);
});
