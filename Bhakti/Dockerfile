FROM node:20-bookworm-slim

# ── System deps: Python, FFmpeg, fonts, espeak-ng, curl
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    fonts-noto-core \
    fontconfig \
    espeak-ng \
    espeak-ng-data \
    curl \
    --no-install-recommends \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

# ── Python packages for TTS ────────────────────────────────────────────
RUN pip3 install edge-tts mutagen gtts --break-system-packages

# ── Higgsfield CLI (Linux amd64) ──────────────────────────────────────
RUN curl -fsSL https://github.com/higgsfield-ai/cli/releases/download/v0.1.34/hf_0.1.34_linux_amd64.tar.gz \
    | tar -xz -C /usr/local/bin higgsfield \
    && ln -sf /usr/local/bin/higgsfield /usr/local/bin/hf \
    && higgsfield version

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
