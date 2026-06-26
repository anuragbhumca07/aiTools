FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/bin/pip3 /usr/local/bin/pip

WORKDIR /app

COPY kronos_trader/ ./kronos_trader/
RUN pip install --no-cache-dir --break-system-packages -r ./kronos_trader/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -e ./kronos_trader/

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY web/ ./web/

ENV PYTHONPATH=/app/kronos_trader

EXPOSE 3009
CMD ["node", "server.js"]
