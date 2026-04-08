FROM manimcommunity/manim:latest

USER root

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt --break-system-packages

COPY . .

RUN mkdir -p videos

EXPOSE 3002

CMD ["python", "server.py"]
