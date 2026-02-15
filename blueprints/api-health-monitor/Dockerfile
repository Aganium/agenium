FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY dist/ ./dist/
COPY blueprints/api-health-monitor/ ./blueprints/api-health-monitor/

WORKDIR /app/blueprints/api-health-monitor

ENV PORT=9011
ENV CHECK_INTERVAL=60
ENV TIMEOUT_MS=10000

EXPOSE 9011

CMD ["npx", "tsx", "agent.ts"]
