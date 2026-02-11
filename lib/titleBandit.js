// lib/titleBandit.js
import fs from "fs";
import path from "path";

const STATE_PATH = process.env.TITLE_BANDIT_PATH || path.join(process.cwd(), "data", "title-bandit.json");

const STYLES = [
  { key: "warning", label: "경고형" },
  { key: "list", label: "리스트형" },
  { key: "mistake", label: "실수형" },
  { key: "compare", label: "비교형" }
];

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function defaultState() {
  // Thompson Sampling(Beta)용 a,b (성공/실패)
  // 초기 비율(60/25/10/5)을 "초기 prior"로 반영 (큰 값 넣으면 고정됨 → 작게)
  return {
    version: 1,
    styles: {
      warning: { a: 6, b: 4 },
      list: { a: 3, b: 7 },
      mistake: { a: 2, b: 8 },
      compare: { a: 1, b: 9 }
    },
    totals: { updates: 0 },
    lastUpdatedAt: new Date().toISOString()
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return defaultState();
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const s = JSON.parse(raw);
    if (!s?.styles) return defaultState();
    return s;
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  ensureDir(STATE_PATH);
  state.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// Beta 샘플링(간단 근사): Gamma 샘플 2개로 ratio
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
function gammaSample(k) {
  // Marsaglia & Tsang (k>=1). k<1은 보정
  if (k < 1) {
    const u = Math.random();
    return gammaSample(1 + k) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x = randn();
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function betaSample(a, b) {
  const x = gammaSample(a);
  const y = gammaSample(b);
  return x / (x + y);
}

export function pickStyle() {
  const state = loadState();
  let best = { key: "warning", score: -1 };
  for (const s of STYLES) {
    const p = state.styles[s.key] || { a: 1, b: 1 };
    const score = betaSample(p.a, p.b);
    if (score > best.score) best = { key: s.key, score };
  }
  return best.key;
}

export function updateStyle(styleKey, reward01) {
  // reward01: 0~1 (성과 좋을수록 1)
  const state = loadState();
  if (!state.styles[styleKey]) state.styles[styleKey] = { a: 1, b: 1 };

  // “성공/실패”로 반영: reward가 0.7이면 성공을 더 많이
  const aInc = Math.max(0.01, reward01);
  const bInc = Math.max(0.01, 1 - reward01);

  state.styles[styleKey].a += aInc;
  state.styles[styleKey].b += bInc;
  state.totals.updates += 1;

  saveState(state);
  return state;
}

export function getWeights() {
  const state = loadState();
  const out = {};
  let sum = 0;
  for (const k of Object.keys(state.styles)) {
    const { a, b } = state.styles[k];
    const mean = a / (a + b);
    out[k] = { a, b, mean };
    sum += mean;
  }
  // 보기 좋게 정규화(참고용)
  const norm = {};
  for (const k of Object.keys(out)) {
    norm[k] = sum > 0 ? out[k].mean / sum : 0.25;
  }
  return { statePath: STATE_PATH, updatedAt: state.lastUpdatedAt, raw: out, normalized: norm, updates: state.totals.updates };
}
