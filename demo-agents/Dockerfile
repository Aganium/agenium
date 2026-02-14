FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json tsconfig.json ./

# Install deps
RUN npm ci --omit=dev 2>/dev/null; npm i tsx -g

# Copy source + built dist
COPY src/ src/
COPY dist/ dist/
COPY demo-agents/ demo-agents/

# Default: echo agent
ENV AGENT=echo
ENV PORT=9001

EXPOSE ${PORT}

CMD npx tsx demo-agents/${AGENT}.ts
