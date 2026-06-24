# Implementation Plan — Airbills, Fee UI, Auto-Delete, Admin Push

## 1. Airbills API migration
- Update `@zend/airbills-client` to the new `developer.airbills.org` API:
  - Base path: `/api/vendor/gateway`
  - Auth header: `secretkey`
  - Endpoints: `POST /transact`, `POST /transact/process`
- Use `transfer` payment mode (returns `data.wallet` + `data.amountInToken` in USDT/USDC).
- After on-chain transfer to `data.wallet`, call `/transact/process` with `productCode` and `id`.
- Map status `03` to a clear auth error message.
- Update `apps/bot/src/services/airbills/index.ts` and webhook handler to use the new order shape.
- Update `.env.example`: `AIRBILLS_SECRET_KEY` (keep `AIRBILLS_API_KEY` fallback for now) and `AIRBILLS_BASE_URL`.

## 2. Transaction fee UI fixes
- Add `formatUsdt` helper that rounds to 2 decimals for display and never hides tiny non-zero fees.
- Off-ramp send:
  - Compute fee from PAJ `order.amount` after order creation, not from local rate-derived `transferUsdt`.
  - Re-quote fee after `fundSolIfNeeded` returns; if user ends up not needing gas sponsorship, reduce displayed/charged fee to normal rate before signing.
  - AUDD path: swap enough USDT to cover `order.amount + feeUsdtAmount`.
- Bulk send: use same post-gas fee recomputation.
- Deposit preview: show PAJ fee if already authenticated; otherwise say “fee calculated after identity check” instead of hard-coded ₦0.
- Bridge/withdraw: keep estimate label but append “(estimate)”.

## 3. Auto-delete restricted to sensitive messages
- Change `autoDeleteMiddleware` to only track bot messages when the current conversation state is a short-TTL sensitive state, or when a handler explicitly marks a message as sensitive.
- Keep `registerUserMessageTracking` but only queue user text/voice messages when state is PIN/OTP/export.
- Keep the explicit 60-second deletion in `wallet-export.ts`.
- Keep `/clear` command as an explicit user action.

## 4. Admin push notifications
- Add Drizzle table `push_notifications` (id, adminId, message, segment, status, createdAt, sentAt, recipientCount).
- Add admin panel menu item “📢 Push Notifications”.
- Flow: admin enters message → choose segment (new users, old users, active, inactive, by tier, by language, all) → confirm → broadcast in batches.
- Query users by segment and send via `bot.telegram.sendMessage` with error logging; update recipient count.
- Targeting categories for first version: new users, old users, active, inactive, by tier, by language, all users.

## 5. Verification
- Run `pnpm build` (tsc) and fix type errors.
- Run `pnpm test` if tests exist for changed modules.
