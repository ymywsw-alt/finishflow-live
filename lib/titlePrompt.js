// lib/titlePrompt.js
export function buildTitlePrompt(topic, styleKey) {
  const styleGuide = {
    warning: "경고형(위험/손해/큰일/지금 당장) 톤",
    list: "리스트형(3가지/5가지/7가지) 톤",
    mistake: "실수형(대부분이 하는 실수/잘못 알고 있는) 톤",
    compare: "비교형(A vs B, 뭐가 더 나은가) 톤"
  }[styleKey] || "경고형 톤";

  const SYSTEM = [
    "너는 시니어 대상 유튜브 제목 전문가다.",
    "조회수(CTR + 시청지속)를 올리는 제목만 만든다.",
    "짧고 강하게. 15~28자.",
    "과장/허위 금지. 실제 정보 기반으로만."
  ].join("\n");

  const USER = [
    `주제: ${topic}`,
    `스타일: ${styleGuide}`,
    "조건:",
    "- 제목 5개 생성",
    "- 중복/유사 문구 금지",
    "- 감탄사 남발 금지",
    "- '충격' 같은 낚시는 금지, 대신 구체적 손해/이익을 써라",
    "출력 형식: 한 줄에 제목 1개씩, 총 5줄"
  ].join("\n");

  return { SYSTEM, USER };
}
