import type { ZendContext } from '../session/types.js';

export async function showLoading(ctx: ZendContext, text: string): Promise<{ message_id: number }> {
  await ctx.replyWithChatAction('typing');
  const msg = await ctx.reply(`⏳ ${text}`);
  return msg;
}

export async function updateLoading(ctx: ZendContext, messageId: number, text: string): Promise<void> {
  await ctx.replyWithChatAction('typing');
  await ctx.telegram.editMessageText(ctx.chat!.id, messageId, undefined, `⏳ ${text}`);
}

export async function finishLoading(
  ctx: ZendContext,
  messageId: number,
  text: string,
  parseMode?: string
): Promise<void> {
  await ctx.telegram.editMessageText(
    ctx.chat!.id,
    messageId,
    undefined,
    text,
    parseMode ? { parse_mode: parseMode as 'Markdown' } : undefined
  );
}