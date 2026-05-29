FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY algo.js server.js ./
COPY web/ ./web/

RUN mkdir -p data logs

EXPOSE 3012

CMD ["node", "server.js"]
