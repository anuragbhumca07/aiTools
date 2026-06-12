FROM node:20-alpine

# Native module build deps (for better-sqlite3)
RUN apk add --no-cache python3 py3-pip make g++ && \
    ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

# Install deps first (cached layer)
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

# Ensure data/uploads dirs exist
RUN mkdir -p data uploads/avatars

EXPOSE 3020

CMD ["node", "server.js"]
