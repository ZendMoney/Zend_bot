import { Markup } from 'telegraf';
import { ConversationState } from '@zend/shared';
import { setSession } from '../../session/store.js';
import { adminSearchKeyboard } from './keyboards.js';
import type { HandlerContext } from '../types.js';

async function requireAdmin(ctx: any, checkAdmin: (userId: string, username?: string) => Promise<boolean>): Promise<boolean> {
  const userId = ctx.from.id.toString();
  const username = ctx.from.username;
  if (!(await checkAdmin(userId, username))) {
    await ctx.answerCbQuery('❌ Not authorized');
    return false;
  }
  return true;
}

export function registerAdminSearchHandlers(
  { bot: b }: HandlerContext,
  checkAdmin: (userId: string, username?: string) => Promise<boolean>
): void {
  b.action('admin_page:search', async (ctx) => {
    if (!(await requireAdmin(ctx, checkAdmin))) return;
    await ctx.editMessageText('🔍 *Search*\n\nWhat do you want to look up?', { parse_mode: 'Markdown', ...adminSearchKeyboard });
    await ctx.answerCbQuery();
  });

  b.action('admin_search:txn', async (ctx) => {
    if (!(await requireAdmin(ctx, checkAdmin))) return;
    const userId = ctx.from!.id.toString();
    setSession(userId, { state: ConversationState.AWAITING_ADMIN_TXN_SEARCH });
    await ctx.editMessageText('🔎 *Search Transaction*\n\nEnter the transaction ID (e.g., `ZND-12345`):', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_cancel_search')]]) });
    await ctx.answerCbQuery();
  });

  b.action('admin_search:user', async (ctx) => {
    if (!(await requireAdmin(ctx, checkAdmin))) return;
    const userId = ctx.from!.id.toString();
    setSession(userId, { state: ConversationState.AWAITING_ADMIN_USER_SEARCH });
    await ctx.editMessageText('👤 *Search User*\n\nEnter a Telegram user ID or @username:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin_cancel_search')]]) });
    await ctx.answerCbQuery();
  });

  b.action('admin_cancel_search', async (ctx) => {
    if (!(await requireAdmin(ctx, checkAdmin))) return;
    const userId = ctx.from!.id.toString();
    setSession(userId, { state: ConversationState.IDLE });
    await ctx.editMessageText('🔍 *Search*\n\nWhat do you want to look up?', { parse_mode: 'Markdown', ...adminSearchKeyboard });
    await ctx.answerCbQuery('Cancelled');
  });
}