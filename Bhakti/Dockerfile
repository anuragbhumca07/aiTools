FROM node:20-bookworm-slim

# ── System deps: Python, FFmpeg, fonts for subtitle (libass) rendering ─
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    fonts-noto-core \
    fontconfig \
    --no-install-recommends \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

# ── Python packages for TTS ────────────────────────────────────────────
RUN pip3 install edge-tts mutagen --break-system-packages

# ── Alias python3 → python ────────────────────────────────────────────
RUN ln -s /usr/bin/python3 /usr/bin/python

# ── App ────────────────────────────────────────────────────────────────
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN mkdir -p out

EXPOSE 3007

CMD ["node", "server.js"]
