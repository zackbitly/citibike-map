FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Data directory will be mounted as a persistent volume
RUN mkdir -p /data

ENV PORT=8080
ENV DATA_DIR=/data

EXPOSE 8080

CMD ["node", "server.js"]
