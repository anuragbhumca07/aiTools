FROM manimcommunity/manim:latest

USER root

WORKDIR /app

# Ensure ffmpeg + ffprobe are in PATH (manim depends on ffmpeg internally
# but some images don't symlink ffprobe into /usr/local/bin)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt --break-system-packages

COPY . .

RUN mkdir -p videos

EXPOSE 3002

CMD ["python", "server.py"]
