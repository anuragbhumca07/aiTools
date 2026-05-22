FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY algo.js server.js ./
COPY web/ ./web/

# Runtime dirs
RUN mkdir -p data logs

EXPOSE 3006

CMD ["node", "server.js"]
