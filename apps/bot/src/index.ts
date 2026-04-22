import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import Redis from 'ioredis';
import { db } from '@zend/db';
import { ConversationState, formatNgn, formatCrypto, truncateAddress } from '@zend/shared';
import { startHandler } from './handlers/start.js';
import { balanceHandler } from './handlers/balance.js';
import { sendHandler } from './handlers/send.js';
import { buyHandler } from './handlers/buy.js';
import { sellHandler } from './handlers/sell.js';
import { receiveHandler } from './handlers/receive.js';
import { historyHandler } from './handlers/history.js';
import { vaultHandler } from './handlers/vault.js';
import { settingsHandler } from './handlers/settings.js';
import { helpHandler } from './handlers/help.js';
import { textHandler } from './handlers/text.js';
import { authMiddleware } from './middleware/auth.js';
import { sessionMiddleware } from './middleware/session.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const bot = new Telegraf(BOT_TOKEN);

// Middleware
bot.use(sessionMiddleware(redis));
bot.use(authMiddleware);

// Commands
bot.command('start', startHandler);
bot.command('balance', balanceHandler);
bot.command('send', sendHandler);
bot.command('buy', buyHandler);
bot.command('sell', sellHandler);
bot.command('receive', receiveHandler);
bot.command('history', historyHandler);
bot.command('vault', vaultHandler);
bot.command('settings', settingsHandler);
bot.command('help', helpHandler);

// Message handlers
bot.on(message('text'), textHandler);
// bot.on(message('voice'), voiceHandler);
// bot.on(message('photo'), photoHandler);

// Callback queries
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  
  if (data === 'confirm_tx') {
    await ctx.answerCbQuery('Processing...');
    // Handle confirmation
  } else if (data === 'cancel_tx') {
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageText('❌ Transaction cancelled.');
  } else if (data === 'menu_balance') {
    await balanceHandler(ctx);
  } else if (data === 'menu_send') {
    await sendHandler(ctx);
  }
});

// Error handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('⚠️ Something went wrong. Please try again or contact support.').catch(() => {});
});

// Start bot
bot.launch();
console.log('🟣 Zend bot is running...');

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
