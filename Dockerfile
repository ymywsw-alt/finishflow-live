# finishflow-live/Dockerfile (WORKER MODE - FULL REPLACE)

FROM node:18-bullseye

# ffmpeg / ffprobe 설치
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 설치
COPY package*.json ./
RUN npm install --omit=dev

# 소스 복사
COPY . .

# worker는 웹서버가 아님 (PORT 바인딩 불필요)
# EXPOSE 없음

# ⚠️ 핵심: server.js 절대 실행하지 말 것
# make.js / execute 엔트리만 실행
CMD ["node", "make.js"]
