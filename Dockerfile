FROM node:22-slim

# ffmpeg 설치 (컨테이너 내부에서 허용)
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

CMD ["npm", "start"]
