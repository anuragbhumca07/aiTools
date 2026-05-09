FROM node:20-bookworm-slim
# REBUILD: 2026-05-08-v3
RUN echo "Rebuild 2026-05-08-v3"

# System deps: Python, FFmpeg, fonts, espeak-ng
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    fonts-noto-core \
    fontconfig \
    espeak-ng \
    espeak-ng-data \
    --no-install-recommends \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

# Python packages for TTS
RUN pip3 install edge-tts mutagen gtts --break-system-packages

# Alias python3 -> python
RUN ln -sf /usr/bin/python3 /usr/bin/python

# ── App ────────────────────────────────────────────────────────────────
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN mkdir -p out

EXPOSE 3007

CMD ["node", "server.js"]
