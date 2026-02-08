import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const WORKER_URL = process.env.WORKER_URL;
const MAKE_TIMEOUT_SEC = Number(process.env.MAKE_TIMEOUT_SEC || 900);

function ok(res, obj) { res.status(200).json(obj); }
function fail(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

app.get("/health", (req, res) => ok(res, { ok: true, service: "finishflow-live" }));

// 이미 Quality Gate v5-auto-insert + retention + anti-slop 삽입이 끝났다고 했으니,
// 여기서는 최종 script.json을 만들고 worker에 전달만 합니다.
app.post("/make", async (req, res) => {
  try {
    if (!WORKER_URL) return fail(res, 500, "WORKER_URL is missing");

    const body = req.body || {};
    // body.topic, body.videoType, body.durationSec 등을 기존 로직대로 받아서
    // script.json을 만든다고 가정 (여기서는 최소 샘플)
    const script = {
      title: body.topic || "시니어를 위한 핵심 요약",
      videoType: body.videoType || "LONG",
      durationSec: body.durationSec || 900,
      captions: body.captions || [
        "결론부터 말씀드립니다.",
        "이 한 가지만 지키면 손해를 줄입니다.",
        "지금 바로 이렇게 해보세요."
      ]
    };

    // multipart/form-data 생성
    const form = new FormData();
    form.append("script.json", new Blob([JSON.stringify(script)], { type: "application/json" }), "script.json");

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), MAKE_TIMEOUT_SEC * 1000);

    const r = await fetch(`${WORKER_URL.replace(/\/$/, "")}/make`, {
      method: "POST",
      body: form,
      signal: controller.signal
    }).finally(() => clearTimeout(t));

    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok) {
      return fail(res, 502, `worker failed: ${data?.error || r.statusText}`);
    }

    // 최종적으로 download_url을 그대로 반환 (목표 1번 달성 포인트)
    return ok(res, {
      ok: true,
      download_url: data.download_url,
      asset_key: data.asset_key,
      durationSec: data.durationSec
    });
  } catch (e) {
    return fail(res, 500, String(e?.message || e));
  }
});

app.listen(PORT, () => {
  console.log(`[live] listening on :${PORT}`);
});
