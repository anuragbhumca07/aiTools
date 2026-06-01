FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production

RUN mkdir -p /data /app/logs

COPY . .

ENV PORT=3013
EXPOSE 3013

CMD ["node", "server.js"]
