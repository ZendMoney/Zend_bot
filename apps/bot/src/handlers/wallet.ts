import { Markup } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { ConversationState } from '@zend/shared';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { isGroupChat, promptPrivateChat } from '../lib/group.js';
import { AUDD_ENABLED } from '../utils/flags.js';
import { getSession, setSession } from '../session/store.js';
import { doExportKey } from './wallet-export.js';
import type { HandlerContext } from './types.js';

export function registerWalletHandlers({ bot: b }: HandlerContext): void {
  b.command('wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const u = user[0];
  const msg =
    `👛 *Your Account*\n\n` +
    `*Your Address:*\n\n` +
    `${u.walletAddress}\n\n` +
    `*Currencies:* SOL, USDT, USDC${AUDD_ENABLED ? ', AUDD' : ''}\n\n` +
    `⚠️ To view your secret code, go to *⚙️ Settings*.`;

  const copyBtn = Markup.inlineKeyboard([
    [{ text: '📋 Copy Address', copy_text: { text: u.walletAddress } } as any]
  ]);

  if (isGroupChat(ctx)) {
    const name = ctx.from?.first_name || 'there';
    await ctx.reply(`📩 ${name}, check your DM for your address.`);
    await ctx.telegram.sendMessage(ctx.from!.id, msg, { parse_mode: 'Markdown', ...copyBtn });
    return;
  }

  await ctx.reply(msg, { parse_mode: 'Markdown', ...copyBtn });
});

  b.action('export_key', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'view your secret code');
    return;
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const u = user[0];

  // If PIN is set, require it first
  if (u.transactionPin) {
    setSession(userId, { state: ConversationState.AWAITING_PIN_VERIFY, pinVerifyAction: 'export' });
    await ctx.editMessageText(
      `🔐 *Security Check*\n\n` +
      `Enter your 4-digit PIN to view your secret code:`,
      { parse_mode: 'Markdown' }
    );
    const waitMsg = await ctx.reply('Waiting for PIN...', cancelKeyboard);
    getSession(userId).lastBotMessageId = waitMsg.message_id;
    return;
  }

  // No PIN set — proceed directly (but warn)
  await ctx.editMessageText(
    `⚠️ *No PIN Set*\n\n` +
    `For security, we recommend setting a PIN in Settings before viewing your secret code.\n\n` +
    `Proceeding anyway...`,
    { parse_mode: 'Markdown' }
  );
  await doExportKey(ctx, userId);
});
}
