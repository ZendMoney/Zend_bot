import { Markup } from 'telegraf';
import { ConversationState } from '@zend/shared';
import type { ZendContext } from '../middleware/session.js';

export async function sendHandler(ctx: ZendContext) {
  const user = (ctx as any).user;
  
  if (!user) {
    await ctx.reply('Please start the bot first with /start');
    return;
  }

  ctx.session.state = ConversationState.AWAITING_SEND_AMOUNT;

  await ctx.reply(
    `📤 *Send Money*\n\n` +
    `Who are you sending to?\n\n` +
    `[🏦 Nigerian Bank Account]\n` +
    `[⛓️ Crypto Wallet Address]\n` +
    `[📱 Saved Contacts]\n` +
    `[❌ Cancel]`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏦 Bank Account', 'send_bank')],
        [Markup.button.callback('⛓️ Crypto Address', 'send_crypto')],
        [Markup.button.callback('❌ Cancel', 'cancel_tx')],
      ]),
    }
  );
}
