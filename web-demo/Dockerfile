FROM node:22-slim

WORKDIR /app

# Install tsx
RUN npm install -g tsx

# Copy web-demo deps
COPY web-demo/package.json web-demo/package-lock.json ./
RUN npm ci --production

# Overwrite npm agenium with local build (has listRemoteTools/callTool)
COPY dist/ ./node_modules/agenium/dist/
COPY package.json ./node_modules/agenium/package.json

# Copy app
COPY web-demo/server.ts web-demo/tsconfig.json ./
COPY web-demo/public/ ./public/

ENV PORT=3080
ENV NODE_ENV=production
EXPOSE 3080

CMD ["tsx", "server.ts"]
