import { db, businesses, businessWallets } from '@zend/db';
import { eq } from 'drizzle-orm';
import { BusinessFlow } from '@zend/shared';
import { businessMainMenu } from '../../keyboards/business.js';
import { formatNgn } from '../../lib/format.js';
import { updateBusinessSession } from '../../services/business/session.js';
import type { ZendContext } from '../../session/types.js';

export async function showBusinessMainMenu(ctx: ZendContext, userId: string) {
  const bizRows = await db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1);
  const biz = bizRows[0];

  let ngnBalance = '₦0';
  let usdcBalance = '$0.00';

  if (biz) {
    const walletRows = await db
      .select()
      .from(businessWallets)
      .where(eq(businessWallets.businessId, biz.id))
      .limit(1);
    if (walletRows.length > 0) {
      ngnBalance = formatNgn(Number(walletRows[0].ngnBalance));
      usdcBalance = `$${Number(walletRows[0].usdcBalance).toFixed(2)}`;
    }
  }

  await updateBusinessSession(userId, {
    currentFlow: BusinessFlow.MAIN_MENU,
    currentStep: null,
  });

  await ctx.reply(
    `*Zend Business — Main Menu*\n` +
      `Balance: ${ngnBalance} | USDC: ${usdcBalance}\n\n` +
      `What would you like to do?`,
    { parse_mode: 'Markdown', ...businessMainMenu },
  );
}