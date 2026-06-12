FROM python:3.11-slim

# Install Node.js 20
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first (cached layer)
COPY kronos_trader/requirements.txt ./kronos_trader/requirements.txt
RUN pip install --no-cache-dir -r kronos_trader/requirements.txt

# Node deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY server.js ./
COPY web/ ./web/
COPY kronos_trader/ ./kronos_trader/

EXPOSE 3009

CMD ["node", "server.js"]
