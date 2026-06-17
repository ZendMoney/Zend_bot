import { Markup } from 'telegraf';
import type { ZendContext } from '../session/types.js';

export function isGroupChat(ctx: ZendContext): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

export function getBotUsername(ctx: ZendContext): string {
  return ctx.botInfo?.username || 'zend_money_bot';
}

export async function promptPrivateChat(ctx: ZendContext, action: string) {
  const name = ctx.from?.first_name || 'there';
  const username = getBotUsername(ctx);
  await ctx.reply(
    `📩 ${name}, please use me in private chat to ${action}.\n\n` +
    `Sensitive actions are only available in DMs for security.`,
    Markup.inlineKeyboard([
      [Markup.button.url('💬 Open Private Chat', `https://t.me/${username}`)],
    ])
  );
}