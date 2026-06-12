FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/bin/pip3 /usr/local/bin/pip

WORKDIR /app

# Python deps
COPY kronos_trader/requirements.txt ./kronos_trader/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r kronos_trader/requirements.txt

# Node deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# CACHE_BUST: change this value to force Docker to rebuild all layers below
ARG CACHE_BUST=20260612_v3
RUN echo "Cache bust: $CACHE_BUST"

# Copy app source fresh
COPY server.js ./
COPY web/ ./web/
COPY kronos_trader/ ./kronos_trader/

# Verify what was actually copied
RUN echo "=== kronos_trader contents ===" && ls -la /app/kronos_trader/ \
 && echo "=== data/ contents ===" && ls -la /app/kronos_trader/data/ \
 && echo "=== main.py first 10 lines ===" && head -10 /app/kronos_trader/main.py

# Register /app/kronos_trader permanently in Python's path via .pth
RUN python3 -c "\
import site, os; \
pth = os.path.join(site.getsitepackages()[0], 'kronos_trader.pth'); \
open(pth, 'w').write('/app/kronos_trader\n'); \
print('Wrote .pth to', pth) \
"

# Verify imports work at build time
RUN python3 -c "from data.kraken_rest import get_ohlcv, get_ticker; from data.data_manager import DataManager; print('data OK')"
RUN python3 -c "from signals.vwap import VWAPSignal; from backtest.engine import BacktestEngine; print('signals+backtest OK')"

ENV PYTHONPATH=/app/kronos_trader

EXPOSE 3009
CMD ["node", "server.js"]
