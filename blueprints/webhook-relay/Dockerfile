FROM node:20-slim
WORKDIR /app
COPY ../../package*.json ./
RUN npm ci --production
COPY . ./blueprints/webhook-relay/
COPY ../../dist ./dist/
EXPOSE 9012 10012
ENV PORT=9012
CMD ["npx", "tsx", "blueprints/webhook-relay/agent.ts"]
