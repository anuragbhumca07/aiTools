FROM node:20-bookworm-slim

# Build deps for better-sqlite3 native module
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies (layer-cached)
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY algo.js server.js ./
COPY web/ ./web/

# Runtime dirs (mount /app/data as a Railway volume for persistence)
RUN mkdir -p data logs

EXPOSE 3006

CMD ["node", "server.js"]
