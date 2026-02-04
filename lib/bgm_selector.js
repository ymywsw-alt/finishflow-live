// lib/bgm_selector.js
// C-stage: BGM preset auto selector (NO user choice)

const PRESETS = {
  CALM_LOOP: "CALM_LOOP",
  DOCUMENTARY: "DOCUMENTARY",
  UPBEAT_SHORTS: "UPBEAT_SHORTS",
};

/**
 * @param {Object} params
 * @param {"LONG"|"SHORT"|string} params.videoType
 * @param {"INFO"|"DOCUMENTARY"|"CALM"|"HEALTH"|"UPBEAT"|string} params.topicTone
 * @param {number} params.durationSec
 * @returns {"CALM_LOOP"|"DOCUMENTARY"|"UPBEAT_SHORTS"}
 */
export function selectBGMPreset({ videoType, topicTone, durationSec }) {
  const vt = String(videoType || "").toUpperCase();
  const tone = String(topicTone || "").toUpperCase();
  const dur = Number(durationSec || 0);

  // Rule 1) Shorts first (<= 60s or explicit SHORT)
  if (vt === "SHORT" || (Number.isFinite(dur) && dur > 0 && dur <= 60)) {
    return PRESETS.UPBEAT_SHORTS;
  }

  // Rule 2) Information/explainer tone => documentary
  if (tone === "INFO" || tone === "DOCUMENTARY") {
    return PRESETS.DOCUMENTARY;
  }

  // Rule 3) Default: calm (esp. senior/health)
  return PRESETS.CALM_LOOP;
}

export const BGM_PRESETS = PRESETS;
