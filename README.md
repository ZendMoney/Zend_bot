# Zend Bot

Telegram-native crypto wallet for Nigerians powered by PAJ Protocol.

## Features

- **Solana Wallet** — Auto-generated on `/start`, no seed phrase needed
- **NGN On-Ramp** — Receive naira via PAJ virtual bank account
- **NGN Off-Ramp** — Send naira to any Nigerian bank account
- **Token Swaps** — Swap SOL, USDT, USDC via Jupiter
- **Savings Vaults** — Auto-save and time-lock funds
- **Natural Language** — "Send 50k to Tunde GTB"
- **Voice & Image** — Voice notes and screenshot OCR

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

# Start bot
pnpm bot:dev

# Start API (in another terminal)
pnpm api:dev
```

## Project Structure

```
zend/
├── apps/
│   ├── bot/          # Telegram bot
│   └── api/          # REST API + webhooks
├── packages/
│   ├── shared/       # Types, constants, utilities
│   ├── db/           # PostgreSQL schema
│   ├── solana/       # Wallet & transaction service
│   └── paj-client/   # PAJ Protocol wrapper
└── infra/            # Docker, deployment
```

## License

Private — For Zend Money use only.
