FROM node:22-slim

# ffmpeg 설치 (컨테이너 내부에서는 허용됨)
RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

CMD ["npm", "start"]
