// lib/ffmpeg_mixer.js  (CommonJS)
// C-stage: mix TTS voice + BGM (length-safe, no desync)

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * 음성 + BGM 합성
 * @param {Object} params
 * @param {string} params.voicePath - TTS 음성 파일 경로
 * @param {string} params.bgmPath - BGM WAV 파일 경로
 * @returns {string} mixed audio file path
 */
function mixVoiceAndBGM({ voicePath, bgmPath }) {
  if (!fs.existsSync(voicePath)) {
    throw new Error(`Voice file not found: ${voicePath}`);
  }
  if (!fs.existsSync(bgmPath)) {
    throw new Error(`BGM file not found: ${bgmPath}`);
  }

  const outPath = path.join("/tmp", `mix_${Date.now()}.wav`);

  // 음성 길이(초) 추출
  const durationCmd =
    `ffprobe -i "${voicePath}" -show_entries format=duration -v quiet -of csv="p=0"`;
  const durationSec = execSync(durationCmd).toString().trim();

  // ffmpeg 믹싱
  const mixCmd = `
ffmpeg -y \
-i "${voicePath}" \
-stream_loop -1 -i "${bgmPath}" \
-filter_complex "amix=inputs=2:weights=2 0.5:dropout_transition=0" \
-t ${durationSec} \
"${outPath}"
`;

  execSync(mixCmd, { stdio: "ignore" });
  return outPath;
}

module.exports = {
  mixVoiceAndBGM,
};
