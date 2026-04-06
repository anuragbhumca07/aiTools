FROM node:20-bookworm-slim

# ── System deps: Python, Chromium, FFmpeg ──────────────────────────
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    python3 \
    python3-pip \
    fonts-liberation \
    fonts-noto \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── Python packages for TTS ────────────────────────────────────────
RUN pip3 install edge-tts mutagen --break-system-packages

# ── Alias python3 → python (server.js calls `python`) ─────────────
RUN ln -s /usr/bin/python3 /usr/bin/python

# ── Remotion: point to system Chromium, skip Puppeteer download ────
ENV REMOTION_CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# ── App ────────────────────────────────────────────────────────────
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
