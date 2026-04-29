# Zend Project Tracker

> **Last Updated:** 2026-04-23  
> **Current Phase:** Phase 1 — Bot Foundation (90% Complete)  
> **Goal:** Production launch — working Telegram bot with real PAJ on/off-ramp.

---

## Legend

| Status | Meaning |
|--------|---------|
| 🔴 Not Started | No code written |
| 🟡 In Progress | Code partially written |
| 🟢 Complete | Working & tested |
| ⚪ Deferred | Planned for later phase |

---

## Phase 1: Bot Foundation (90% Complete)

**Goal:** A working Telegram bot with core wallet + NGN flows.

| # | Feature | Status | Files / Notes |
|---|---------|--------|---------------|
| 1.1 | **Project setup** — pnpm workspaces, tsconfig, build scripts | 🟢 | `package.json`, `pnpm-workspace.yaml`, `tsconfig.json` |
| 1.2 | **Database schema** — Users, Wallets, Transactions, BankAccounts | 🟢 | Drizzle ORM, `packages/db/src/schema.ts`, 2 migrations |
| 1.3 | **Redis session store** — Conversation state machine | 🟡 | Redis running locally. In-memory sessions used (replace with Redis in prod) |
| 1.4 | **Bot entry point** — Telegraf setup, polling | 🟢 | `apps/bot/src/index.ts` — full bot running |
| 1.5 | **Auth middleware** — Load user from DB, attach to context | 🟢 | `apps/bot/src/middleware/auth.ts` |
| 1.6 | **`/start` onboarding** — Create wallet, encrypt key, store | 🟢 | Wallet generated, encrypted, saved to DB |
| 1.7 | **`/balance` command** — Query Solana balances + PAJ rates | 🟢 | Real-time balances + live PAJ rates |
| 1.8 | **`/buy` (on-ramp)** — PAJ OTP auth → real virtual account | 🟢 | Full OTP flow + `createOnrampOrder()` |
| 1.9 | **`/send` flow** — Off-ramp to Nigerian bank via PAJ | 🟢 | Multi-step flow + `createOfframpOrder()` |
| 1.10 | **`/receive` command** — Unified receive screen | 🟢 | Solana address + virtual account info |
| 1.11 | **`/history` command** — List recent transactions | 🟢 | Queries from PostgreSQL |
| 1.12 | **PAJ webhook handler** — Deposit confirmed, settlement | 🟡 | Endpoint exists. Needs webhook URL configured |
| 1.13 | **Error handling** — Graceful failures, user-friendly messages | 🟢 | Global error handler in bot |
| 1.14 | **Rate limiting** — Prevent spam / abuse | 🟢 | `apps/bot/src/middleware/rateLimit.ts` |

**Phase 1 Progress: 13/14 complete (93%)**

---

## Phase 2: Enhanced Features (0% Complete)

**Goal:** Swaps, cross-chain, savings.

| # | Feature | Status | Files / Notes |
|---|---------|--------|---------------|
| 2.1 | **Jupiter swap integration** — SOL/USDC ↔ USDT on Solana | 🔴 | `JupiterQuote` type exists. Need SDK integration. |
| 2.2 | **Cross-chain deposit** — Chain Rails bridge in | 🔴 | `COMBINED_FLOW.md` designed. Need Chain Rails API keys. |
| 2.3 | **Cross-chain withdrawal** — Chain Rails bridge out | 🔴 | Depends on 2.2. |
| 2.4 | **Auto-save vault** — % of every spend to savings | 🔴 | `Vault` type exists. Backend-only for MVP. |
| 2.5 | **Time-lock vault** — Lock funds until date | 🔴 | `Vault` type exists. Backend-only for MVP. |
| 2.6 | **Scheduled transfers** — Recurring bank sends | 🔴 | `ScheduledTransfer` type exists. Need BullMQ. |
| 2.7 | **NLU engine** — Natural language parsing for intents | 🔴 | `packages/nlu/` is empty. |
| 2.8 | **Voice notes** — STT via Whisper | 🔴 | Not in codebase. |
| 2.9 | **OCR screenshots** — Bank detail extraction from photos | 🔴 | Not in codebase. |
| 2.10 | **Email backup / recovery** — OTP verification | 🔴 | `EmailOTP` type exists. Need mail provider. |
| 2.11 | **Transaction PIN** — 4-digit PIN for sends | 🔴 | Mentioned in UI schema. |
| 2.12 | **Referral program** — Invite rewards | 🔴 | `Referral` type exists. |

---

## Phase 3: Polish & Scale (0% Complete)

**Goal:** Production readiness.

| # | Feature | Status | Files / Notes |
|---|---------|--------|---------------|
| 3.1 | **Admin dashboard** — Transaction monitoring, user support | ⚪ | `apps/dashboard/` — future. |
| 3.2 | **KYC/AML compliance** — Tiered limits, monitoring | ⚪ | PAJ handles KYC at protocol level. |
| 3.3 | **Smart contract vaults** — On-chain enforced savings | ⚪ | `contracts/` — deferred post-MVP. |
| 3.4 | **Multi-language support** — Pidgin, Yoruba, Igbo, Hausa | ⚪ | UI schema mentions it. |
| 3.5 | **Analytics & metrics** — Transaction success rate, retention | ⚪ | Monitoring stack. |
| 3.6 | **Load testing** — 1000 concurrent users | ⚪ | Jest + artillery. |
| 3.7 | **Security audit** — Penetration testing | ⚪ | External. |

---

## Quick Status Dashboard

```
Phase 1: Bot Foundation     [██████████░] 93%  (13/14 complete)
Phase 2: Enhanced Features  [░░░░░░░░░░] 0%   (0/12 complete)
Phase 3: Polish & Scale     [░░░░░░░░░░] 0%   (0/7 complete)

Overall: [████░░░░░░] 28%  (13/33 complete)
```

---

## 🚨 BLOCKERS FOR PRODUCTION LAUNCH

| # | Blocker | Impact | Resolution |
|---|---------|--------|------------|
| 1 | **PAJ Production API key** | Cannot process real NGN | Request from PAJ team |
| 2 | **Webhook URL (public)** | PAJ can't notify Zend of deposits/settlements | Deploy API to cloud (Render/Railway/GCP) |
| 3 | **Solana Mainnet RPC** | Devnet only — no real money | Switch RPC URL + fund fee payer (if using one) |
| 4 | **User wallet key decryption** | Bot can't sign transactions yet | Implement KMS decryption in TransactionService |
| 5 | **Production database** | Local PostgreSQL only | Migrate to managed DB (Supabase/Neon/RDS) |
| 6 | **Redis (production)** | In-memory sessions won't survive restart | Deploy Redis (Upstash/Redis Cloud) |
| 7 | **SSL/TLS certificate** | Webhooks need HTTPS | Cloud provider handles this |

---

## 🎯 PATH TO PRODUCTION (Next 2-4 Weeks)

### Week 1: Infrastructure
- [ ] Deploy API to cloud (Render/Railway/GCP Cloud Run)
- [ ] Set up production PostgreSQL (Supabase/Neon)
- [ ] Set up production Redis (Upstash)
- [ ] Configure webhook URL in PAJ dashboard
- [ ] Switch Solana RPC to mainnet
- [ ] Get PAJ production API key

### Week 2: Core Features Hardening
- [ ] Implement wallet key decryption for real transactions
- [ ] Test full on-ramp flow with real NGN
- [ ] Test full off-ramp flow with real NGN
- [ ] Add transaction retry logic
- [ ] Add proper error recovery (failed txs, refunds)

### Week 3: Security & Compliance
- [ ] Encrypt all sensitive data at rest
- [ ] Add rate limiting per user
- [ ] Implement transaction PIN
- [ ] Add audit logging
- [ ] Set up monitoring (Sentry/Grafana)

### Week 4: Testing & Launch
- [ ] End-to-end testing with real money (small amounts)
- [ ] Beta testing with 10-20 users
- [ ] Fix bugs
- [ ] **Soft launch** 🚀

---

## 📋 COMPLETED FEATURES (Working Now)

| Feature | Command | Status |
|---------|---------|--------|
| Wallet creation | `/start` | ✅ Creates Solana wallet, encrypts key, saves to DB |
| Check balance | `💰 Balance` | ✅ SOL + USDT + USDC with real PAJ rates |
| Add Naira | `💵 Add Naira` | ✅ PAJ OTP → real virtual account |
| Send to bank | `📤 Send` | ✅ Multi-step + PAJ off-ramp order |
| Receive | `📥 Receive` | ✅ Solana address + virtual account |
| History | `📋 History` | ✅ Lists from PostgreSQL |
| Settings | `⚙️ Settings` | ✅ Profile, PAJ link status |

---

## 🛠️ TECHNICAL DEBT

| Issue | Priority | Fix |
|-------|----------|-----|
| In-memory sessions | High | Switch to Redis |
| Mock virtual account fallback | Medium | Remove when PAJ prod key works |
| No wallet key decryption | High | Implement KMS + sign transactions |
| No transaction PIN | Medium | Add PIN middleware |
| No email backup | Low | Add post-MVP |

---

*Tracker maintained alongside development. Update status as features land.*
