FROM node:20-bookworm-slim

# Install Python 3 + pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Make python3/pip3 available as python/pip
RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/bin/pip3 /usr/local/bin/pip

WORKDIR /app

# Python deps (cached layer — only rebuilds if requirements change)
COPY kronos_trader/requirements.txt ./kronos_trader/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r kronos_trader/requirements.txt

# Node deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY server.js ./
COPY web/ ./web/
COPY kronos_trader/ ./kronos_trader/

# Bake PYTHONPATH into the image so every Python subprocess can find subpackages
ENV PYTHONPATH=/app/kronos_trader

# Verify the data package is importable at build time — fails build if files are missing
RUN python -c "from data.kraken_rest import get_ohlcv, get_ticker; print('data package OK')"

EXPOSE 3009

CMD ["node", "server.js"]
