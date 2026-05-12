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

# Copy workspace files
COPY package.json pnpm-workspace.yaml ./
COPY apps/bot/package.json apps/bot/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/*/package.json packages/*/

# Install dependencies (including QVAC native builds)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build if needed (QVAC compiles native addons during install)
# Models download on first use — set QVAC_MODEL_DIR to persist them
ENV QVAC_MODEL_DIR=/app/models
ENV QVAC_USE_LIGHT_MODELS=true
ENV NODE_ENV=production

# Create models directory
RUN mkdir -p /app/models

# Start command
CMD ["sh", "-c", "pnpm db:migrate && pnpm exec tsx apps/bot/src/index.ts"]
