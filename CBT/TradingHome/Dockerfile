FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY web/ ./web/

EXPOSE 3015

CMD ["node", "server.js"]
