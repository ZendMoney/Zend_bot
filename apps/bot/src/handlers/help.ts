import { db, users, transactions, botFeatures } from '@zend/db';
import { eq, and } from 'drizzle-orm';
import { ConversationState } from '@zend/shared';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { formatNgn } from '../lib/format.js';
import { md } from '../lib/telegram.js';
import { setSession } from '../session/store.js';
import type { HandlerContext } from './types.js';

export function registerHelpHandlers({ bot: b }: HandlerContext): void {
b.hears('❓ Help', async (ctx) => {
  await ctx.reply(
    `❓ *Zend Help*\n\n` +
    `Need support? Reach out anytime:\n\n` +
    `• 📖 Tap *How to Use* for a quick guide\n` +
    `• ✨ Tap *Features* to see what Zend can do\n` +
    `• 📝 Tap *Feedback* to share ideas or report bugs\n\n` +
    `👉 [Zend Community](https://t.me/zend_community)`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, ...mainMenu }
  );
});

b.hears('📖 How to Use', async (ctx) => {
  await ctx.reply(
    `📖 *How to Use Zend*\n\n` +
    `*1. Add Money*\n` +
    `Tap 💰 *Balance* → *Add Naira* → follow the bank transfer instructions. Your virtual account converts Naira to USDT instantly.\n\n` +
    `*2. Send to Any Nigerian Bank*\n` +
    `Tap 📤 *Send* → enter amount → choose or add a bank account → confirm with your PIN.\n\n` +
    `*3. Receive Money*\n` +
    `Tap 📥 *Receive* → share your wallet address or virtual account details.\n\n` +
    `*4. Swap Crypto*\n` +
    `Tap 🔄 *Swap* → pick the token pair → enter amount → confirm.\n\n` +
    `*5. Pay Bills*\n` +
    `Tap 💳 *Bills* → choose Airtime, Data, Electricity, or Cable → fill details → pay with USDT.\n\n` +
    `*6. Bulk / Scheduled Sends*\n` +
    `Tap 📦 *Bulk Send* to pay many people at once, or 📅 *Schedule* for recurring payments.\n\n` +
    `*Tips:*\n` +
    `• Keep a tiny amount of SOL for network gas, or let Zend sponsor it for a small fee.\n` +
    `• Set a transaction PIN in ⚙️ *Settings* for extra security.\n` +
    `• Voice commands work too — just send a voice note.`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

b.hears('✨ Features', async (ctx) => {
  try {
    const features = await db.select().from(botFeatures).where(eq(botFeatures.isActive, true)).orderBy(botFeatures.sortOrder);
    if (!features.length) {
      await ctx.reply('✨ No features listed right now. Check back soon!', mainMenu);
      return;
    }
    let text = '✨ *Zend Features*\n\n';
    const byCategory: Record<string, typeof features> = {};
    for (const f of features) {
      byCategory[f.category] = byCategory[f.category] || [];
      byCategory[f.category].push(f);
    }
    for (const [category, list] of Object.entries(byCategory)) {
      text += `*${md(category.toUpperCase())}*\n`;
      for (const f of list) {
        text += `• *${md(f.name)}* — ${md(f.description)}\n`;
      }
      text += '\n';
    }
    await ctx.reply(text, { parse_mode: 'Markdown', ...mainMenu });
  } catch (err) {
    console.error('[Features] Handler error:', err);
    await ctx.reply('❌ Could not load features. Please try again.', mainMenu);
  }
});

b.hears('📝 Feedback', async (ctx) => {
  const userId = ctx.from!.id.toString();
  setSession(userId, { state: ConversationState.AWAITING_FEEDBACK_TEXT });
  await ctx.reply(
    `📝 *Send Feedback*\n\n` +
    `We read every message\. Share a bug, feature idea, or anything else:\n\n` +
    `Type your feedback below\. Tap ❌ Cancel to discard\.`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 🧹 CLEAR CHAT
// ═════════════════════════════════════════════════════════════════════════════

b.command('clear', async (ctx) => {
  const chatId = ctx.chat.id;
  const currentMsgId = ctx.message?.message_id;

  if (!currentMsgId) {
    await ctx.reply('❌ Could not clear chat.', mainMenu);
    return;
  }

  const statusMsg = await ctx.reply('🧹 Clearing recent bot messages...');

  let deleted = 0;
  // Try deleting the last 15 messages before the current one
  for (let offset = 1; offset <= 15; offset++) {
    try {
      const msgId = currentMsgId - offset;
      if (msgId <= 0) break;
      await ctx.telegram.deleteMessage(chatId, msgId);
      deleted++;
    } catch (e) {
      // Message not from bot, too old, or already deleted — continue
    }
  }

  // Delete the status message too
  try {
    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id);
  } catch (e) { /* ignore */ }

  // Delete the /clear command itself
  try {
    await ctx.telegram.deleteMessage(chatId, currentMsgId);
  } catch (e) { /* ignore */ }

  const confirmMsg = await ctx.reply(`✅ Cleared ${deleted} messages.`, mainMenu);
  // Auto-delete confirmation after 3 seconds
  setTimeout(async () => {
    try {
      await ctx.telegram.deleteMessage(chatId, confirmMsg.message_id);
    } catch (e) { /* ignore */ }
  }, 3000);
});

// ═════════════════════════════════════════════════════════════════════════════
// 📊 STATS
// ═════════════════════════════════════════════════════════════════════════════

b.command('stats', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    // Personal stats
    const userTxs = await db.select().from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.status, 'completed')));
    const sendTxs = userTxs.filter(t => t.type === 'ngn_send');
    const swapTxs = userTxs.filter(t => t.type === 'swap');
    const schedTxs = userTxs.filter(t => t.type === 'scheduled');
    const totalNgn = sendTxs.reduce((sum, t) => sum + Number(t.ngnAmount || 0), 0);
    const totalSwaps = swapTxs.length + schedTxs.length;

    // Platform stats
    const allTxs = await db.select().from(transactions).where(eq(transactions.status, 'completed'));
    const platformSends = allTxs.filter(t => t.type === 'ngn_send');
    const platformNgn = platformSends.reduce((sum, t) => sum + Number(t.ngnAmount || 0), 0);
    const userCount = (await db.select().from(users)).length;

    await ctx.reply(
      `📊 *Your Stats*\n\n` +
      `💰 Total Sent: ${formatNgn(totalNgn)}\n` +
      `📤 Transfers: ${sendTxs.length}\n` +
      `🔄 Swaps: ${totalSwaps}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 *Platform Stats*\n\n` +
      `👥 Users: ${userCount}\n` +
      `💰 Total Volume: ${formatNgn(platformNgn)}\n` +
      `📤 Total Transfers: ${platformSends.length}`,
      { parse_mode: 'Markdown', ...mainMenu }
    );
  } catch (err) {
    console.error('Stats error:', err);
    await ctx.reply('❌ Could not fetch stats. Please try again.', mainMenu);
  }
});
}
