FROM node:20-slim

WORKDIR /app

# Copy the full agenium SDK (needed for createAgent)
COPY package.json package-lock.json ./
RUN npm ci --production

COPY dist/ ./dist/
COPY blueprints/log-analyzer/ ./blueprints/log-analyzer/

WORKDIR /app/blueprints/log-analyzer

ENV LOG_PATH=/logs/access.log
ENV PORT=9010

EXPOSE 9010

CMD ["npx", "tsx", "agent.ts"]
