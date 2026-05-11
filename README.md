# Zend Bot

Telegram-native crypto wallet for Nigerians powered by PAJ Protocol and **QVAC local AI**.

## Features

- **Solana Wallet** — Auto-generated on `/start`, no seed phrase needed
- **NGN On-Ramp** — Receive naira via PAJ virtual bank account
- **NGN Off-Ramp** — Send naira to any Nigerian bank account
- **Token Swaps** — Swap SOL, USDT, USDC via Jupiter
- **Savings Vaults** — Auto-save and time-lock funds
- **Natural Language** — "Send 50k to Tunde GTB"
- **Voice Commands** — Send a voice note, QVAC transcribes and parses it locally
- **Receipt OCR** — Send a screenshot of any bank app, QVAC reads the payment details
- **Smart History Search** — Ask "How much did I send Mama last month?" using QVAC embeddings
- **Sovereign AI** — All AI runs on-device via QVAC. Zero cloud API calls. Full privacy.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Bot | Node.js + Telegraf |
| API | Hono |
| Database | PostgreSQL + Drizzle ORM |
| Cache | Redis |
| Blockchain | Solana + @solana/web3.js |
| Fiat | PAJ Protocol (paj_ramp) |
| Swaps | Jupiter DEX Aggregator |
| **AI** | **QVAC SDK (@qvac/sdk) — local-first, offline-capable** |

## QVAC Integration

Zend integrates **5 QVAC capabilities** across core user flows:

| QVAC Module | Feature | User Value |
|-------------|---------|------------|
| `@qvac/llm-llamacpp` | Command parsing + conversational AI | Understands Pidgin, Hausa, Yoruba, Igbo mixed with English |
| `@qvac/transcription-whispercpp` | Voice-to-text | Send money by voice note — works offline |
| `@qvac/ocr-onnx` | Receipt/screenshot parsing | Screenshot a bank app → auto-filled transfer |
| `@qvac/embed-llamacpp` | Semantic transaction search | "How much did I send Mama?" — finds it instantly |
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
    │                └─── Fallback: QVAC LLM (Qwen3 4B)
    │
    ├─── Voice ──→ QVAC Whisper (tiny) ──→ QVAC LLM Parser
    │
    ├─── Photo ──→ QVAC OCR (0.6B multimodal) ──→ QVAC LLM Parser
    │
    └─── History Query ──→ QVAC Embeddings (Gemma 300M) ──→ QVAC LLM Summary
```

All models load once and stay in memory. No network calls during inference.

## Quick Start

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

## Project Structure

```
zend/
├── apps/
│   ├── bot/                  # Telegram bot
│   │   └── src/
│   │       └── services/
│   │           └── qvac/     # QVAC integration modules
│   │               ├── index.ts      # Model loader & lifecycle
│   │               ├── llm.ts        # LLM completion wrapper
│   │               ├── transcribe.ts # Whisper STT
│   │               ├── ocr.ts        # Receipt OCR
│   │               ├── embed.ts      # Semantic search
│   │               ├── translate.ts  # African language NMT
│   │               └── prompts.ts    # All system prompts
│   └── api/                  # REST API + webhooks
├── packages/
│   ├── shared/       # Types, constants, utilities
│   ├── db/           # PostgreSQL schema
│   ├── solana/       # Wallet & transaction service
│   └── paj-client/   # PAJ Protocol wrapper
└── infra/            # Docker, deployment
```

## Hackathon Submission

This project is submitted to:

- **Colosseum Frontier Hackathon** (main track)
- **Tether QVAC Side Track** — $10,000 USDT for meaningful QVAC integration

**Demo Video:** [Link to Loom/YouTube]
**Live Bot:** [Link to Telegram bot]

## License

Private — For Zend Money use only.
