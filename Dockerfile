# ZendPay Bot with QVAC Local AI
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
COPY packages/airbills-client/package.json packages/airbills-client/package.json
COPY packages/near-intents-client/package.json packages/near-intents-client/package.json

# Install dependencies (QVAC compiles native addons during install)
RUN pnpm install

# Copy source code
COPY . .

# QVAC: cache on a Railway volume mount (Settings → Volumes → mount at /data/qvac)
ENV QVAC_MODEL_DIR=/data/qvac
ENV QVAC_CONFIG_PATH=/app/qvac.config.mjs
ENV QVAC_USE_LIGHT_MODELS=true
ENV QVAC_DOWNLOAD_ON_START=true
# Keep one model in RAM at a time; unload after 5m idle (saves Railway memory)
ENV QVAC_MAX_LOADED_MODELS=1
ENV QVAC_IDLE_UNLOAD_MS=300000
ENV NODE_ENV=production

# Start: migrate → download models once to volume → run bot
CMD ["sh", "-c", "mkdir -p \"$QVAC_MODEL_DIR\" && pnpm db:migrate && if [ \"$QVAC_DOWNLOAD_ON_START\" = \"true\" ]; then pnpm exec tsx apps/bot/scripts/ensure-qvac-models.ts; fi && pnpm exec tsx apps/bot/src/index.ts"]
