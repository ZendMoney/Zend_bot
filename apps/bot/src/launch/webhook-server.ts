import { createServer } from 'http';
import type { Server } from 'http';
import type { Telegraf } from 'telegraf';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, users, transactions, billPayments, ambassadorApplications, deviceSuspensionRequests } from '@zend/db';
import { eq, sql } from 'drizzle-orm';
import { SOLANA_TOKENS } from '@zend/shared';
import { DEV_WALLET_SECRET, getPublicBaseUrl, walletService } from '../deps.js';
import { mainMenu } from '../keyboards/index.js';
import { generateTxId } from '../lib/ids.js';
import { getAuddPriceInUsdt } from '../services/pricing.js';
import { decryptPrivateKey } from '../utils/wallet.js';
import {
  verifyPajWebhookSignature,
  normalizePajWebhookEvent,
  webhookEventKey,
  isDuplicateWebhook,
  markWebhookProcessed,
} from '../utils/paj-webhook.js';

export function startWebhookServer(botInstance: Telegraf<any>): Server {
  const port = parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3001');

  const server = createServer(async (req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (url === '/health' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
      return;
    }

    // PAJ Webhooks
    if (url === '/webhooks/paj' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const signature = req.headers['x-paj-signature'] as string | undefined;
          if (!verifyPajWebhookSignature(body, signature)) {
            console.warn('[PAJ Webhook] Invalid signature');
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }

          const parsed = JSON.parse(body);
          const event = normalizePajWebhookEvent(parsed);
          if (!event) {
            console.log('[PAJ Webhook] Unrecognized payload:', body.slice(0, 200));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'Unrecognized event' }));
            return;
          }

          const idemKey = webhookEventKey({ type: event.type, reference: event.reference });
          if (idemKey && isDuplicateWebhook(idemKey)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'Duplicate' }));
            return;
          }

          console.log('📩 PAJ Webhook:', event.type, event.reference);

          switch (event.type) {
            case 'onramp.deposit.confirmed': {
              // Find or create transaction
              let txRows = await db.select().from(transactions)
                .where(eq(transactions.pajReference, event.reference))
                .limit(1);

              if (txRows.length > 0 && txRows[0].status === 'completed') {
                break;
              }

              if (txRows.length === 0) {
                // Try to find user by virtual account orderId
                const userRows = await db.select().from(users)
                  .where(sql`virtual_account->>'orderId' = ${event.reference}`)
                  .limit(1);
                if (userRows.length > 0) {
                  const fallbackTxId = generateTxId();
                  await db.insert(transactions).values({
                    id: fallbackTxId,
                    userId: userRows[0].id,
                    type: 'ngn_receive',
                    status: 'completed',
                    pajReference: event.reference,
                    pajPoolAddress: userRows[0].walletAddress,
                    recipientWalletAddress: userRows[0].walletAddress,
                    completedAt: new Date(),
                  });
                  txRows = [{ id: fallbackTxId, userId: userRows[0].id } as any];
                } else {
                  console.warn('[PAJ Webhook] No transaction or user found for reference:', event.reference);
                }
              } else {
                await db.update(transactions)
                  .set({ status: 'completed', completedAt: new Date() })
                  .where(eq(transactions.pajReference, event.reference));
              }

              // Check if this on-ramp should be converted to AUDD (hidden swap)
              let notified = false;
              try {
                if (txRows.length > 0) {
                  const targetToken = (txRows[0].metadata as any)?.targetToken;
                  if (targetToken === 'AUDD') {
                    const userId = txRows[0].userId;
                    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
                    if (user.length > 0 && user[0].walletEncryptedKey) {
                      const usdtAmount = Number(txRows[0].fromAmount || 0);
                      if (usdtAmount > 0) {
                        const auddRate = await getAuddPriceInUsdt();
                        const auddOut = usdtAmount / auddRate;
                        if (DEV_WALLET_SECRET) {
                          const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_SECRET));
                          const devAuddBalance = await walletService.getTokenBalance(devKeypair.publicKey.toBase58(), SOLANA_TOKENS.AUDD.mint);
                          if (devAuddBalance >= auddOut) {
                            const secretKey = await decryptPrivateKey(user[0].walletEncryptedKey);
                            const keypair = Keypair.fromSecretKey(secretKey);
                            const swapTxHash = await walletService.executeLocalSwap(
                              keypair,
                              devKeypair,
                              SOLANA_TOKENS.USDT.mint,
                              SOLANA_TOKENS.AUDD.mint,
                              usdtAmount,
                              auddOut,
                              SOLANA_TOKENS.USDT.decimals,
                              SOLANA_TOKENS.AUDD.decimals,
                              user[0].walletAddress
                            );
                            const swapTxId = generateTxId();
                            await db.insert(transactions).values({
                              id: swapTxId, userId, type: 'swap', status: 'completed',
                              fromMint: SOLANA_TOKENS.USDT.mint, fromAmount: usdtAmount.toString(),
                              toMint: SOLANA_TOKENS.AUDD.mint, toAmount: auddOut.toString(),
                              solanaTxHash: swapTxHash,
                            });
                            await botInstance.telegram.sendMessage(
                              userId,
                              `🎉 *AUDD Deposit Complete!*\n\n` +
                              `Your Naira bank transfer has been confirmed and AUDD has been credited to your ZendPay account.\n\n` +
                              `Received: ~${auddOut.toFixed(2)} AUDD\n` +
                              `Reference: \`${event.reference}\``,
                              { parse_mode: 'Markdown' }
                            );
                            notified = true;
                          } else {
                            console.error('[AUDD On-ramp] Dev wallet AUDD balance too low:', devAuddBalance, 'needed:', auddOut);
                          }
                        }
                      }
                    }
                  }
                }
              } catch (swapErr) {
                console.error('[AUDD On-ramp] Hidden swap failed:', swapErr);
              }

              // Notify user (default USDT notification)
              try {
                if (!notified && txRows.length > 0) {
                  const userId = txRows[0].userId;
                  await botInstance.telegram.sendMessage(
                    userId,
                    `🎉 *Naira Deposit Received!*\n\n` +
                    `Your bank transfer has been confirmed and Dollars (USDT) have been credited to your ZendPay account.\n\n` +
                    `Reference: \`${event.reference}\``,
                    { parse_mode: 'Markdown' }
                  );
                }
              } catch (notifyErr) {
                console.log('[PAJ Webhook] Could not notify user:', notifyErr);
              }
              break;
            }
            case 'onramp.deposit.failed': {
              const txRows = await db.select().from(transactions)
                .where(eq(transactions.pajReference, event.reference))
                .limit(1);
              if (txRows.length > 0) {
                await db.update(transactions)
                  .set({ status: 'failed' })
                  .where(eq(transactions.pajReference, event.reference));
              } else {
                console.warn('[PAJ Webhook] No transaction found for failed deposit:', event.reference);
              }
              break;
            }
            case 'offramp.settlement.confirmed': {
              const offrampRows = await db.select().from(transactions)
                .where(eq(transactions.pajReference, event.reference))
                .limit(1);

              if (offrampRows.length > 0 && offrampRows[0].status === 'completed') {
                break;
              }

              await db.update(transactions)
                .set({ status: 'completed', completedAt: new Date() })
                .where(eq(transactions.pajReference, event.reference));

              // Notify user
              try {
                const txRows = await db.select().from(transactions)
                  .where(eq(transactions.pajReference, event.reference))
                  .limit(1);
                if (txRows.length > 0) {
                  const userId = txRows[0].userId;
                  await botInstance.telegram.sendMessage(
                    userId,
                    `✅ *Cash Out Complete!*\n\n` +
                    `Your Naira has been settled to your bank account.\n\n` +
                    `Reference: \`${event.reference}\``,
                    { parse_mode: 'Markdown' }
                  );
                }
              } catch (notifyErr) {
                console.log('[PAJ Webhook] Could not notify user:', notifyErr);
              }
              break;
            }
            case 'offramp.settlement.failed': {
              await db.update(transactions)
                .set({ status: 'failed' })
                .where(eq(transactions.pajReference, event.reference));
              break;
            }
          }

          if (idemKey) markWebhookProcessed(idemKey);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err: any) {
          console.error('Webhook error:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // NEAR Intents Webhooks
    if (url === '/webhooks/near-intents' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const event = JSON.parse(body);
          console.log('📩 NEAR Intents Webhook:', event.status, event.depositAddress);

          const depositAddress = event.depositAddress || event.deposit_address;
          const status = event.status;
          const amount = event.amountOut || event.amount_out;
          const token = event.destinationAsset?.symbol || event.originAsset?.symbol || 'USDT';

          if (!depositAddress) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing depositAddress' }));
            return;
          }

          const idemKey = webhookEventKey({ status, reference: depositAddress });
          if (idemKey && isDuplicateWebhook(idemKey)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'Duplicate' }));
            return;
          }

          // Find transaction by NEAR Intents deposit address
          const txRows = await db.select().from(transactions)
            .where(eq(transactions.nearIntentDepositAddress, depositAddress))
            .limit(1);

          if (txRows.length === 0) {
            console.warn('[NEAR Intents Webhook] No transaction found for deposit:', depositAddress);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'No matching transaction' }));
            return;
          }

          const tx = txRows[0];

          // Idempotency: don't re-process completed transactions
          if (tx.status === 'completed') {
            console.log('[NEAR Intents Webhook] Transaction already completed, skipping:', depositAddress);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, note: 'Already completed' }));
            return;
          }

          const txStatus = status === 'SUCCESS' ? 'completed' : status === 'FAILED' || status === 'REFUNDED' ? 'failed' : 'processing';

          // Update transaction
          await db.update(transactions)
            .set({
              status: txStatus,
              toAmount: amount ? amount.toString() : tx.toAmount,
              completedAt: txStatus === 'completed' ? new Date() : undefined,
            })
            .where(eq(transactions.id, tx.id));

          // Notify user via Telegram
          const isWithdraw = tx.type === 'crypto_send' || (tx.metadata as any)?.direction === 'withdraw';
          if (txStatus === 'completed') {
            const userId = tx.userId;
            try {
              const msg = isWithdraw
                ? `✅ *Withdrawal Complete!*\n\n` +
                  `${amount || ''} ${token} delivered to the recipient address.\n\n` +
                  `Reference: \`${tx.id}\``
                : `✅ *Deposit Received!*\n\n` +
                  `${amount || ''} ${token} has arrived in your ZendPay account via NEAR Intents.\n\n` +
                  `Reference: \`${tx.id}\``;
              await botInstance.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown', ...mainMenu });
            } catch (notifyErr) {
              console.log('[NEAR Intents] Could not notify user:', notifyErr);
            }
          } else if (txStatus === 'failed' && isWithdraw) {
            try {
              await botInstance.telegram.sendMessage(
                tx.userId,
                `❌ *Withdrawal Failed*\n\nReference: \`${tx.id}\`\nFunds should be refunded to your ZendPay wallet.`,
                { parse_mode: 'Markdown', ...mainMenu }
              );
            } catch { /* non-critical */ }
          }

          if (idemKey) markWebhookProcessed(idemKey);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err: any) {
          console.error('NEAR Intents webhook error:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // AirBills Webhooks
    if (url === '/webhooks/airbills' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const event = JSON.parse(body);
          // New gateway sends the transaction object directly; support old wrapper too
          const transactionId = event.id || event.transactionId || event.orderId;
          const status = event.status || event.transactionStatus;
          const token = event.token || event.data?.token;
          console.log('📩 AirBills Webhook:', transactionId, status);

          if (!transactionId) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
            return;
          }

          const orders = await db.select().from(billPayments)
            .where(eq(billPayments.externalReference, transactionId))
            .limit(1);

          if (!orders.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true }));
            return;
          }

          const order = orders[0];

          if (status === 'completed' || status === 'success') {
            await db.update(billPayments)
              .set({ status: 'success', token, completedAt: new Date() })
              .where(eq(billPayments.id, order.id));

            await botInstance.telegram.sendMessage(
              order.userId,
              `🎉 *Bill Payment Complete!*\n\n` +
              `${order.type?.toUpperCase()} — ₦${Number(order.amountNgn).toLocaleString()}\n` +
              `Recipient: ${order.recipient}` +
              (token ? `\n\n🔑 *Token:* \`${token}\`` : '') +
              `\n\nReference: \`${order.reference}\``,
              { parse_mode: 'Markdown' }
            );
          } else if (status === 'failed') {
            await db.update(billPayments)
              .set({ status: 'failed', metadata: event })
              .where(eq(billPayments.id, order.id));

            await botInstance.telegram.sendMessage(
              order.userId,
              `❌ *Bill Payment Failed*\n\n` +
              `${order.type?.toUpperCase()} — ₦${Number(order.amountNgn).toLocaleString()}\n` +
              `Recipient: ${order.recipient}\n\n` +
              `If USDT was deducted, it will be refunded.`,
              { parse_mode: 'Markdown' }
            );
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err: any) {
          console.error('[AirBills Webhook] Error:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Telegram Bot Webhooks — ack immediately (Telegram times out if handler is slow)
    if (url.split('?')[0] === '/webhook/telegram' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.writeHead(200);
        res.end('OK');
        try {
          const update = JSON.parse(body);
          botInstance.handleUpdate(update).catch((err: any) => {
            console.error('[Webhook] Telegram update error:', err);
          });
        } catch (err: any) {
          console.error('[Webhook] Telegram parse error:', err);
        }
      });
      return;
    }

    // ─── Landing page forms ───
    if (url === '/api/ambassador' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { name, tgHandle, isStudent, focus } = data;
          if (!name || !tgHandle || !isStudent || !focus) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'All fields are required' }));
            return;
          }
          await db.insert(ambassadorApplications).values({
            name: String(name).trim(),
            tgHandle: String(tgHandle).trim(),
            isStudent: String(isStudent).trim(),
            focus: String(focus).trim(),
          });
          console.log('📩 Ambassador application received:', name, tgHandle);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          console.error('[Webhook] Ambassador error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save application' }));
        }
      });
      return;
    }

    if (url === '/api/device-suspend' && method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { fullName, email, phone, handle, deviceLost, lastUsed, reason, details } = data;
          if (!fullName || !email || !phone || !handle || !deviceLost || !lastUsed || !reason) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Required fields missing' }));
            return;
          }
          await db.insert(deviceSuspensionRequests).values({
            fullName: String(fullName).trim(),
            email: String(email).trim(),
            phone: String(phone).trim(),
            handle: String(handle).trim(),
            deviceLost: String(deviceLost).trim(),
            lastUsed: String(lastUsed).trim(),
            reason: String(reason).trim(),
            details: details ? String(details).trim() : null,
          });
          console.log('📩 Device suspension request received:', fullName, email);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          console.error('[Webhook] Device suspension error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save request' }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '0.0.0.0', () => {
    const publicBase = getPublicBaseUrl();
    console.log(`🌐 Webhook server listening on 0.0.0.0:${port}`);
    if (publicBase) {
      console.log(`   Public base URL: ${publicBase}`);
      console.log(`   PAJ webhook URL: ${publicBase}/webhooks/paj`);
      console.log(`   NEAR Intents webhook URL: ${publicBase}/webhooks/near-intents`);
      console.log(`   AirBills webhook URL: ${publicBase}/webhooks/airbills`);
      console.log(`   Telegram webhook URL: ${publicBase}/webhook/telegram`);
      console.log(`   Ambassador API: ${publicBase}/api/ambassador`);
      console.log(`   Device Suspend API: ${publicBase}/api/device-suspend`);
    } else {
      console.warn('⚠️  No public URL configured — external webhooks (PAJ/AirBills/NEAR) will NOT reach this server');
      console.warn('   Set WEBHOOK_BASE_URL or expose the Railway service to set RAILWAY_PUBLIC_DOMAIN');
      console.log(`   Local only: http://localhost:${port}`);
    }
  });

  return server;
}
