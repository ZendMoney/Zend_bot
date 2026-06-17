import { initSessionStore } from '../session/store.js';
import { initQVAC, getQVACStatus } from '../services/qvac/index.js';
import { runStartupHealthChecks } from './health.js';
import { startWebhookServer } from './webhook-server.js';
import { seedBotFeatures } from '../services/bot-features.js';
import { bot } from '../bot.js';
import { airbillsClient, getPAJClient, getPublicBaseUrl, SOLANA_RPC } from '../deps.js';
import { runScheduledTransfers } from '../jobs/scheduled-transfers.js';
import { pollNearIntentTransactions } from '../jobs/near-intents-poller.js';

export async function run(): Promise<void> {
  await initSessionStore();

  const health = await runStartupHealthChecks({ getPAJClient, airbillsClient });
  if (!health.database) {
    process.exit(1);
  }

  try {
    await initQVAC();
    const qvacStatus = getQVACStatus();
    console.log('🧠 QVAC AI stack initialized');
    console.log('   Models:', JSON.stringify(qvacStatus.models));
  } catch (err: any) {
    console.warn('⚠️  QVAC init failed:', err.message);
  }

  await seedBotFeatures();

  startWebhookServer(bot);

  const publicBaseUrl = getPublicBaseUrl();
  const useTelegramWebhook = process.env.TELEGRAM_USE_WEBHOOK === 'true';
  let isWebhookMode = false;

  async function clearWebhook(retries = 3): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('[Bot] Telegram webhook cleared');
        return true;
      } catch (err: any) {
        console.warn(`[Bot] Failed to clear webhook (attempt ${i + 1}/${retries}):`, err.message);
        if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
      }
    }
    return false;
  }

  if (useTelegramWebhook && publicBaseUrl) {
    const telegramWebhookUrl = `${publicBaseUrl}/webhook/telegram`;
    try {
      await bot.telegram.setWebhook(telegramWebhookUrl, { drop_pending_updates: true });
      console.log('🤖 Zend bot running in Telegram webhook mode');
      console.log(`   Webhook URL: ${telegramWebhookUrl}`);
      isWebhookMode = true;
    } catch (webhookErr: any) {
      console.error('[Bot] Failed to set Telegram webhook:', webhookErr.message);
      console.log('🤖 Falling back to polling mode...');
      await clearWebhook();
      await bot.launch({ dropPendingUpdates: true });
      console.log('🤖 Zend bot running in polling mode (webhook fallback)');
    }
  } else {
    await clearWebhook();
    await bot.launch({ dropPendingUpdates: true });
    console.log('🤖 Zend bot running in polling mode');
    if (!useTelegramWebhook) {
      console.log('   PAJ/AirBills HTTP webhooks still active on the same server');
      console.log('   (Set TELEGRAM_USE_WEBHOOK=true only if Telegram can reach your domain)');
    }
  }

  setInterval(() => runScheduledTransfers(bot), 60000);
  console.log('📅 Scheduled transfer executor started (every 60s)');

  setInterval(() => pollNearIntentTransactions(bot), 120000);
  console.log('🔗 NEAR Intents status poller started (every 120s)');

  if (process.env.NODE_ENV === 'production' && SOLANA_RPC.includes('devnet')) {
    console.warn('⚠️  SOLANA_RPC_URL points to devnet in production — switch to mainnet for real funds');
  }

  console.log('🔔 Balance change detector: DISABLED (RPC rate limit protection)');

  let retryTimeout: NodeJS.Timeout | null = null;
  let retryCount = 0;
  const MAX_409_RETRIES = 10;

  process.on('unhandledRejection', async (reason: any) => {
    if (!isWebhookMode && reason?.response?.error_code === 409) {
      retryCount++;
      const delay = Math.min(5000 * Math.pow(2, retryCount - 1), 60000);
      console.log(`[Bot] 409 conflict (retry ${retryCount}/${MAX_409_RETRIES}), retrying in ${delay}ms...`);

      try { await bot.stop(); } catch { /* may already be stopped */ }
      if (retryTimeout) clearTimeout(retryTimeout);

      if (retryCount > MAX_409_RETRIES) {
        console.error('[Bot] Max 409 retries exceeded. Exiting.');
        process.exit(1);
      }

      retryTimeout = setTimeout(async () => {
        console.log('[Bot] Retrying polling launch...');
        try {
          await bot.launch({ dropPendingUpdates: true });
          retryCount = 0;
          console.log('🤖 Bot polling restarted successfully');
        } catch (err: any) {
          console.error('[Bot] Polling relaunch failed:', err.message);
        }
      }, delay);
      return;
    }

    console.error('[UnhandledRejection]', reason);
  });

  process.once('SIGINT', () => {
    if (retryTimeout) clearTimeout(retryTimeout);
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    if (retryTimeout) clearTimeout(retryTimeout);
    bot.stop('SIGTERM');
  });
}