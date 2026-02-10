FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# lib 폴더를 앱 루트로 고정
WORKDIR /app/lib

# deps
COPY lib/package*.json ./
RUN npm install --omit=dev

# source
COPY lib ./

EXPOSE 3000
CMD ["node", "server.js"]
