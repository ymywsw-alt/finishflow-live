FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# ❌ EXPOSE 없음
# ❌ server.js 실행 없음

CMD ["node", "server.js"]

