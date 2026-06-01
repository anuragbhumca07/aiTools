FROM node:20-slim

# Python + build tools for better-sqlite3
RUN apt-get update && apt-get install -y python3 python3-pip make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production

# Python deps — MetaTrader5 is Windows-only; on Linux this will fail gracefully
# (bridge reports "not installed" and server runs in paper-only mode)
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt || true

RUN mkdir -p /data /app/logs

COPY . .

ENV PORT=3014
EXPOSE 3014

CMD ["node", "server.js"]
