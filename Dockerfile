FROM node:22-slim

# ffmpeg
RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

# deps
COPY package*.json ./
RUN npm install

# app
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
