# Zend Bot with QVAC Local AI
# Railway deployment using Docker for full system library control

FROM node:22-slim

# Install system dependencies for QVAC native addons + libatomic
RUN apt-get update && apt-get install -y \
    libatomic1 \
    libstdc++6 \
    build-essential \
    python3 \
    cmake \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all workspace package.json files (preserve directory structure)
COPY apps/bot/package.json apps/bot/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/solana/package.json packages/solana/package.json
COPY packages/paj-client/package.json packages/paj-client/package.json
COPY packages/chainrails-client/package.json packages/chainrails-client/package.json
COPY packages/nlu/package.json packages/nlu/package.json

# Install dependencies (QVAC compiles native addons during install)
RUN pnpm install

# Copy source code
COPY . .

# Build if needed
ENV QVAC_MODEL_DIR=/app/models
ENV QVAC_USE_LIGHT_MODELS=true
ENV NODE_ENV=production

# Create models directory
RUN mkdir -p /app/models

# Start command
CMD ["sh", "-c", "pnpm db:migrate && pnpm exec tsx apps/bot/src/index.ts"]
