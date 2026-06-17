import { db, ambassadorApplications } from '@zend/db';
import { sql } from 'drizzle-orm';
import { escapeTelegramMarkdown } from '../lib/telegram.js';
import {
  getAmbassadorActiveUserCount,
  getAmbassadorMonthlyVolume,
  getAmbassadorTotalVolume,
  getAmbassadorTierFromCount,
  getCommissionRateBps,
  calculateCommissionNgn,
  formatAmbassadorTier,
} from './admin/ambassador-helpers.js';
import type { HandlerContext } from './types.js';

export function registerMyrefHandlers({ bot: b }: HandlerContext): void {
  b.command('myref', async (ctx) => {
    const username = ctx.from.username;
    const handle = username ? username.toLowerCase().replace(/^@/, '') : '';

    if (!handle) {
      await ctx.reply('❌ You need a Telegram username to be an ambassador. Set one in Telegram Settings.');
      return;
    }

    const ambRows = await db.select().from(ambassadorApplications)
      .where(sql`LOWER(${ambassadorApplications.tgHandle}) = LOWER(${handle})`)
      .limit(1);

    if (ambRows.length === 0) {
      await ctx.reply(
        `🧑‍🎓 *ZendPayER Programme*\n\n` +
        `You are not registered as a ZendPay ambassador.\n\n` +
        `Apply at: https://zend-simple-payments-production.up.railway.app/ambassador`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const amb = ambRows[0];

    if (amb.status === 'pending') {
      await ctx.reply(
        `⏳ *ZendPayER Application Pending*\n\n` +
        `Hi ${escapeTelegramMarkdown(amb.name)}, your application is being reviewed.\n\n` +
        `Complete your starter tasks and the team will confirm you soon.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (amb.status === 'removed') {
      await ctx.reply(
        `❌ *ZendPayER Status Removed*\n\n` +
        `Your ambassador access has been revoked. Contact the programme manager for more info.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    let activeCount = 0;
    let totalVolume = 0;
    let currentMonthVolume = 0;
    if (amb.customReferralCode) {
      activeCount = await getAmbassadorActiveUserCount(amb.customReferralCode);
      totalVolume = await getAmbassadorTotalVolume(amb.customReferralCode);
      const now = new Date();
      currentMonthVolume = await getAmbassadorMonthlyVolume(amb.customReferralCode, now.getFullYear(), now.getMonth() + 1);
    }

    const computedTier = getAmbassadorTierFromCount(activeCount);
    const rate = getCommissionRateBps(computedTier);
    const monthCommission = calculateCommissionNgn(currentMonthVolume, computedTier);
    const totalCommission = calculateCommissionNgn(totalVolume, computedTier);
    const nextTier = computedTier === 'entry' ? 'Pro (75)' : computedTier === 'pro' ? 'Elite (300)' : 'Maxed';
    const toNext = computedTier === 'entry' ? Math.max(0, 75 - activeCount) : computedTier === 'pro' ? Math.max(0, 300 - activeCount) : 0;

    let text =
      `🎯 *Your ZendPayER Dashboard*\n\n` +
      `*Name:* ${escapeTelegramMarkdown(amb.name)}\n` +
      `*Tier:* ${formatAmbassadorTier(computedTier)}\n` +
      `*Commission Rate:* ${(rate / 100).toFixed(2)}%\n\n`;

    if (amb.customReferralCode) {
      text +=
        `🔗 *Your Referral Link*\n` +
        `\`t.me/zend_money_bot?start=${amb.customReferralCode}\`\n\n`;
    }

    text +=
      `📊 *Stats*\n` +
      `• Active Users: ${activeCount}${toNext > 0 ? ` (${toNext} to ${nextTier})` : ''}\n` +
      `• Total Volume: ₦${totalVolume.toLocaleString()}\n` +
      `• This Month Volume: ₦${currentMonthVolume.toLocaleString()}\n` +
      `• Est. Monthly Commission: ₦${Math.round(monthCommission).toLocaleString()}\n` +
      `• Est. Total Commission: ₦${Math.round(totalCommission).toLocaleString()}\n\n` +
      `💡 Only users who sign up *and complete a transaction* count as active.`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });
}