FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# lib 폴더를 통째로 복사
COPY lib ./lib

# lib 기준으로 설치/실행
WORKDIR /app/lib
RUN npm install --omit=dev

EXPOSE 3000
CMD ["node", "server.js"]
