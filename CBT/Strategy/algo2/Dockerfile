FROM node:20-bookworm-slim

# Install Python 3 + pip
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

# App source — copy everything fresh (no layer reuse from prior stale builds)
COPY server.js ./
COPY web/ ./web/
COPY kronos_trader/ ./kronos_trader/

# Permanently register /app/kronos_trader in Python's site-packages via .pth file.
# This fires for every Python process in this container before any import runs —
# no reliance on PYTHONPATH, cwd, sys.path tricks, or -m flag behaviour.
RUN python3 -c "\
import site, os; \
pth = os.path.join(site.getsitepackages()[0], 'kronos_trader.pth'); \
open(pth, 'w').write('/app/kronos_trader\n'); \
print('Wrote', pth) \
"

# Verify the full import chain works at build time
RUN python3 -c "from data.kraken_rest import get_ohlcv, get_ticker; from data.data_manager import DataManager; print('data OK')"
RUN python3 -c "from signals.vwap import VWAPSignal; from backtest.engine import BacktestEngine; print('signals+backtest OK')"

ENV PYTHONPATH=/app/kronos_trader

EXPOSE 3009
CMD ["node", "server.js"]
