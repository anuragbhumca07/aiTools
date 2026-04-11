FROM node:20-slim

WORKDIR /app

# Build tools needed for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p data

EXPOSE 3003

CMD ["node", "server.js"]
