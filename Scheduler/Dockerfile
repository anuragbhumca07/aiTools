FROM node:20-slim

WORKDIR /app

# Build tools + ffmpeg for thumbnail extraction
RUN apt-get update && apt-get install -y python3 make g++ ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p data

EXPOSE 3003

CMD ["node", "server.js"]
