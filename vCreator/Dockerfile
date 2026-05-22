FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip \
    fonts-liberation fonts-noto-core fontconfig \
    --no-install-recommends \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install edge-tts mutagen Pillow --break-system-packages
RUN ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN mkdir -p out public/music

EXPOSE 8080
CMD ["node", "server.js"]
