FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/bin/pip3 /usr/local/bin/pip

WORKDIR /app

# ── Step 1: copy the entire kronos_trader package (including setup.cfg) ──
# and install it as an editable Python package.
# This registers data/, signals/, strategy/, backtest/, kronos/, etc.
# as real installed packages in site-packages — no PYTHONPATH required.
COPY kronos_trader/ ./kronos_trader/
RUN pip install --no-cache-dir --break-system-packages -e ./kronos_trader/

# Verify imports work at build time
RUN python3 -c "from data.kraken_rest import get_ohlcv, get_ticker; from signals.vwap import VWAPSignal; print('ALL IMPORTS OK')"

# ── Step 2: Node deps ──────────────────────────────────────────────────
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Step 3: remaining app source ──────────────────────────────────────
COPY server.js ./
COPY web/ ./web/

EXPOSE 3009
CMD ["node", "server.js"]
