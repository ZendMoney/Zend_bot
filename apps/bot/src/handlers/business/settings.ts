import { Markup } from 'telegraf';
import { db, businesses } from '@zend/db';
import { eq } from 'drizzle-orm';
import { businessMainMenu } from '../../keyboards/business.js';
import { showLoading, finishLoading } from '../../lib/loading.js';
import { md } from '../../lib/telegram.js';
import type { ZendContext } from '../../session/types.js';

export async function showBusinessSettings(ctx: ZendContext, userId: string) {
  const loading = await showLoading(ctx, 'Loading settings...');

  try {
    const bizRows = await db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1);
    if (bizRows.length === 0) {
      await finishLoading(ctx, loading.message_id, 'Please complete business onboarding first.');
      await ctx.reply('Menu:', businessMainMenu);
      return;
    }

    const biz = bizRows[0];
    const bankLine =
      biz.bankName && biz.accountNumber ? `${biz.bankName} — ${biz.accountNumber}` : 'Not set';

    const msg =
      `⚙️ *Business Settings*\n\n` +
      `🏢 *Profile*\n` +
      `Business: ${md(biz.name || 'Not set')}\n` +
      `Email: ${md(biz.email || 'Not set')}\n` +
      `Phone: ${md(biz.phone || 'Not set')}\n` +
      `Settlement bank: ${md(bankLine)}\n` +
      `Invoice prefix: ${md(biz.invoicePrefix)}\n` +
      `Plan: ${md(biz.subscriptionPlan)}\n` +
      `Free invoices left: ${biz.invoiceQuotaRemaining}`;

    await finishLoading(ctx, loading.message_id, msg, 'Markdown');
    await ctx.reply('Menu:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👤 Switch to Personal Mode', 'settings_switch_personal')],
      ]),
    });
  } catch (err) {
    console.error('Business settings error:', err);
    await finishLoading(ctx, loading.message_id, '❌ Could not load settings. Please try again.');
    await ctx.reply('Menu:', businessMainMenu);
  }
}