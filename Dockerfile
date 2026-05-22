FROM node:20-alpine

WORKDIR /app

COPY package*.json ./\
RUN npm install

COPY . .

# Port must match PORT in .env
EXPOSE 9999

# Healthcheck: check the /health endpoint every 30s
# If the WhatsApp session is disconnected/unhealthy, Docker will restart the container
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:9999/health || exit 1

CMD ["npm", "start"]
