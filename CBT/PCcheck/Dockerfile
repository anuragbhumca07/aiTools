FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY monitor_server.py .
COPY .env* ./
EXPOSE 5000
CMD ["python", "monitor_server.py"]
