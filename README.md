# Zend Bot

Telegram-native crypto wallet for Nigerians powered by PAJ Protocol and **QVAC local AI**.

## Features

### Core Wallet & Banking
- **Solana Wallet** — Auto-generated on `/start`, no seed phrase needed. AES-256-GCM encrypted at rest.
- **NGN On-Ramp** — Receive naira via PAJ virtual bank account (OTP-verified)
- **NGN Off-Ramp** — Send naira to any Nigerian bank account with live rate quotes
- **Balance & Rates** — Real-time SOL/USDT/USDC balances with live PAJ NGN rates
- **Receive** — Unified receive screen showing Solana address + virtual account details
- **Transaction History** — Full history with smart semantic search

### Crypto & Swaps
- **Token Swaps** — Swap SOL ↔ USDT ↔ USDC via Jupiter DEX Aggregator
- **Cross-Chain Deposits** — Bridge assets from other chains via ChainRails
- **Gasless Transactions** — Dev wallet auto-funds SOL for users with insufficient gas

### Bills & Utilities
- **Airtime** — Buy phone credit for MTN, Glo, Airtel, 9mobile
- **Data Bundles** — Purchase data plans across all networks
- **Electricity** — Pay prepaid/postpaid bills for all Nigerian DISCOs
- **Cable TV** — Subscribe to DSTV, GOTV, Startimes bouquets

### Automation & Scheduling
- **Scheduled Transfers** — Set up recurring bank sends (daily, weekly, monthly)
- **Saved Recipients** — Auto-save bank accounts for faster future sends
- **Milestone Rewards** — Celebrates volume and count milestones with users

### Security & Privacy
- **Transaction PIN** — 4-digit PIN with PBKDF2 hashing for sensitive actions
- **Secret Key Export** — Encrypted export with auto-destruct after 60 seconds
- **Auto-Delete Messages** — Sensitive messages self-destruct after 10 minutes (PIN after 5 seconds)
- **Rate Limiting** — Per-user spam protection

### AI-Powered Experience (QVAC)
- **Natural Language Commands** — *"Send 50k to Tunde GTB"* — QVAC LLM parses intent locally
- **Voice Commands** — Send a voice note, QVAC transcribes and parses it offline
- **Receipt OCR** — Screenshot any bank app, QVAC reads payment details locally
- **Smart History Search** — *"How much did I send Mama last month?"* — QVAC embeddings find it instantly
- **African Language Support** — Pidgin, Hausa, Yoruba, Igbo mixed with English
- **Sovereign AI** — All AI runs on-device via QVAC. Zero cloud API calls. Full privacy.

### Group Chat & Community
- **Group Mentions** — Tag the bot (`@ZendBot`) or reply to use features in groups
- **Private Actions** — Sensitive flows (send, swap, export) automatically redirect to DM
- **Community Link** — Direct access to Zend community from main menu

### Admin Dashboard
- **`/admin`** — Admin panel with stats, user lookup, transaction monitoring
- **QVAC Status** — Real-time model loading status (`🤖 QVAC Status`)
- **Scheduled Monitoring** — View and manage all scheduled transfers

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Bot | Node.js + Telegraf |
| API | Hono |
| Database | PostgreSQL + Drizzle ORM |
| Cache | Redis (Upstash-ready) |
| Blockchain | Solana + @solana/web3.js |
| Fiat | PAJ Protocol (paj_ramp) |
| Swaps | Jupiter DEX Aggregator |
| Cross-Chain | ChainRails |
| **AI** | **QVAC SDK (@qvac/sdk) — local-first, offline-capable** |
| Deployment | Docker + Railway |

## QVAC Integration

Zend integrates **5 QVAC capabilities** across core user flows:

| QVAC Module | Feature | User Value |
|-------------|---------|------------|
| `@qvac/llm-llamacpp` | Command parsing + conversational AI | Understands Pidgin, Hausa, Yoruba, Igbo mixed with English |
| `@qvac/transcription-whispercpp` | Voice-to-text | Send money by voice note — works offline |
| `@qvac/ocr-onnx` | Receipt/screenshot parsing | Screenshot a bank app → auto-filled transfer |
| `@qvac/embed-llamacpp` | Semantic transaction search | *"How much did I send Mama?"* — finds it instantly |
| `@qvac/translation-nmtcpp` | African language translation | Full multilingual support for Nigerian languages |

### Why QVAC?

Cloud AI (OpenAI, Anthropic, Kimi) cannot serve the median Nigerian user:

- **Data is expensive** — Every API call = 5-50KB HTTPS payload. Local inference = zero data cost.
- **Internet is intermittent** — API timeout = failed transaction. QVAC works offline.
- **Financial privacy** — Bank details never leave the device. No foreign servers.
- **Cost sustainability** — API fees would make Zend unaffordable for low-income users.

QVAC makes Zend the **first African crypto wallet with fully sovereign AI**.

### Architecture

```
User Message
    │
    ├─── Text ──→ Local Regex Parser (fast path)
    │                └─── Fallback: QVAC LLM (Qwen3 4B / Llama 3.2 1B)
    │
    ├─── Voice ──→ QVAC Whisper (tiny) ──→ QVAC LLM Parser
    │
    ├─── Photo ──→ QVAC OCR (multimodal) ──→ QVAC LLM Parser
    │
    └─── History Query ──→ QVAC Embeddings (Gemma 300M) ──→ QVAC LLM Summary
```

All models load once and stay in memory. No network calls during inference.

### How to Access QVAC

QVAC is built into Zend — no separate setup needed for users. For developers and admins:

1. **Check QVAC Status**: Send `/admin` → tap **`🤖 QVAC Status`** to see which models are loaded
2. **Pre-load models**: Run the download script before starting the bot
3. **Toggle light models**: Set `QVAC_USE_LIGHT_MODELS=true` for resource-constrained deploys

```bash
# Download all QVAC models ahead of time (optional — models auto-download on first use)
npx tsx apps/bot/scripts/download-qvac-models.ts
```

## Quick Start

### Prerequisites
- Node.js 22+
- pnpm 10+
- PostgreSQL 15+
- Redis 7+ (or use in-memory fallback for local dev)
- FFmpeg (for voice note processing)

### Local Development

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your BOT_TOKEN, PAJ_API_KEY, etc.

# Start infrastructure
docker-compose -f infra/docker-compose.yml up -d

# Run database migrations
pnpm db:migrate

# Download QVAC models (optional — models auto-download on first use)
npx tsx apps/bot/scripts/download-qvac-models.ts

# Start bot
pnpm dev:bot

# Start API (in another terminal)
pnpm dev:api
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis connection string |
| `SOLANA_RPC_URL` | ✅ | Solana RPC endpoint (devnet/mainnet) |
| `PAJ_BUSINESS_API_KEY` | ✅ | PAJ Protocol API key |
| `ENCRYPTION_KEY` | ✅ | 64-character hex key for wallet encryption |
| `ZEND_FEE_WALLET` | ✅ | Solana address that receives fees |
| `ZEND_DEV_WALLET_SECRET` | ❌ | Base58 secret key for gas sponsorship |
| `QVAC_MODEL_DIR` | ❌ | Model cache directory (default: `./models`) |
| `QVAC_USE_LIGHT_MODELS` | ❌ | Use lightweight models for deploys (default: `true`) |
| `CHAINRAILS_API_KEY` | ❌ | For cross-chain deposit bridge |
| `WEBHOOK_BASE_URL` | ❌ | Public URL for PAJ/ChainRails webhooks |

See `.env.example` for the full list.

## Project Structure

```
zend/
├── apps/
│   ├── bot/                  # Telegram bot
│   │   └── src/
│   │       ├── index.ts              # Bot entry point + handlers
│   │       ├── middleware/           # Auth, rate limiting
│   │       └── services/
│   │           ├── qvac/             # QVAC integration modules
│   │           │   ├── index.ts      # Model loader & lifecycle
│   │           │   ├── llm.ts        # LLM completion wrapper
│   │           │   ├── transcribe.ts # Whisper STT
│   │           │   ├── ocr.ts        # Receipt OCR
│   │           │   ├── embed.ts      # Semantic search
│   │           │   ├── translate.ts  # African language NMT
│   │           │   └── prompts.ts    # All system prompts
│   │           ├── nlp.ts            # Natural language parser (regex + QVAC)
│   │           ├── jupiter.ts        # Jupiter swap integration
│   │           ├── bills/            # Bill payments (airtime, data, etc.)
│   │           └── admin.ts          # Admin dashboard helpers
│   └── api/                  # REST API + webhooks
│       └── src/
│           ├── index.ts      # Hono server
│           └── routes/       # PAJ & ChainRails webhooks
├── packages/
│   ├── shared/       # Types, constants, utilities
│   ├── db/           # PostgreSQL schema + Drizzle ORM
│   ├── solana/       # Wallet & transaction service
│   ├── paj-client/   # PAJ Protocol wrapper
│   ├── chainrails-client/  # ChainRails bridge wrapper
│   └── nlu/          # NLU types (future expansion)
├── infra/            # Docker, docker-compose, deployment configs
└── drizzle/          # Database migrations
```

## Deployment

### Docker

```bash
# Build image
docker build -t zend-bot .

# Run with env file
docker run --env-file .env -p 3000:3000 zend-bot
```

### Railway (Recommended)

1. Connect repo to Railway
2. Set environment variables in Railway dashboard
3. Add PostgreSQL + Redis plugins (or use external)
4. Deploy — Dockerfile handles QVAC native addon compilation

**Note:** QVAC requires `libatomic1`, `build-essential`, `cmake`, and `ffmpeg`. The included Dockerfile installs these automatically.

## Available Commands

| Command | Description |
|---------|-------------|
| `/start` | Create wallet and onboard |
| `/wallet` | View Solana address |
| `/admin` | Admin dashboard (restricted) |
| `/bridge` | Cross-chain deposit |
| `/stats` | Public bot statistics |
| `/clear` | Clear conversation state |

**Main Menu Buttons:**
- `💰 Balance` — View balances
- `💵 Add Naira` — On-ramp via PAJ
- `📤 Send` — Off-ramp to Nigerian bank
- `💴 Cash Out` — Quick bank withdrawal
- `🔄 Swap` — Jupiter token swaps
- `📥 Receive` — Deposit address + virtual account
- `📅 Schedule` — Recurring transfers
- `📋 History` — Transaction history
- `💳 Bills` — Airtime, data, electricity, cable
- `⚙️ Settings` — PIN, PAJ link, export key

## License

Private — For Zend Money use only.
