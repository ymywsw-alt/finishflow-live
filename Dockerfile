# finishflow-live/Dockerfile (FULL REPLACE for worker web service)
# - Must keep an HTTP server running (Render Web Service requirement)
# - Install ffmpeg/ffprobe for video processing

FROM node:18-bullseye

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Render sets PORT, server.js must listen on process.env.PORT
ENV NODE_ENV=production

CMD ["node", "server.js"]
