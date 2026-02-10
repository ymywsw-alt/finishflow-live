FROM node:22-bookworm-slim

# ffmpeg (make.js가 ffmpeg 실행)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) 의존성 설치: lib/package.json 기준
COPY lib/package*.json ./lib/
RUN cd lib && npm install --omit=dev

# 2) 소스 복사
COPY lib ./lib

# 3) 실행
EXPOSE 3000
CMD ["node", "lib/server.js"]
