FROM node:20-slim
WORKDIR /app
COPY ../../package*.json ./
RUN npm ci --production
COPY . ./blueprints/api-health-monitor/
COPY ../../dist ./dist/
EXPOSE 9011
ENV PORT=9011
CMD ["npx", "tsx", "blueprints/api-health-monitor/agent.ts"]
