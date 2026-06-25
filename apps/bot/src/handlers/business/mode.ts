import { Markup } from 'telegraf';
import { db, users, ambassadorApplications, businesses } from '@zend/db';
import { eq, and } from 'drizzle-orm';
import type { ZendMode } from '@zend/shared';
import { ConversationState } from '@zend/shared';
import { walletService } from '../../deps.js';
import { mainMenu } from '../../keyboards/index.js';
import { generateReferralCode } from '../../lib/ids.js';
import { encryptPrivateKey } from '../../utils/wallet.js';
import { getSession, setSession } from '../../session/store.js';
import { ensureBusinessSession, setActiveMode } from '../../services/business/session.js';
import type { ZendContext } from '../../session/types.js';
import { startOnboarding } from '../start.js';
import { startBusinessOnboarding, resumeBusinessOnboardingIfNeeded } from './onboarding.js';
import { showBusinessMainMenu } from './main-menu.js';
import { resolveActiveMode as getActiveMode } from '../../services/business/mode.js';
import type { HandlerContext } from '../types.js';

export async function showModePicker(ctx: ZendContext, userId: string, startPayload?: string) {
  setSession(userId, {
    state: ConversationState.AWAITING_MODE_SELECTION,
    pendingStartPayload: startPayload,
  });

  await ctx.reply(
    '*Welcome to Zend!*\n\nWhat would you like to use Zend for?',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('👤 Personal — wallet & payments', 'mode_personal')],
      [Markup.button.callback('🏢 Business — invoicing & collections', 'mode_business')],
    ]) },
  );
}

export async function createUserWithMode(
  ctx: ZendContext,
  userId: string,
  mode: ZendMode,
  startPayload?: string,
) {
  const username = ctx.from!.username;
  const firstName = ctx.from!.first_name;
  const lastName = ctx.from!.last_name || '';

  let ambassadorRefCode: string | undefined;
  let referredByUserId: string | undefined;

  if (startPayload) {
    const ambassadorMatch = await db
      .select()
      .from(ambassadorApplications)
      .where(
        and(
          eq(ambassadorApplications.customReferralCode, startPayload.toLowerCase()),
          eq(ambassadorApplications.status, 'confirmed'),
        ),
      )
      .limit(1);
    if (ambassadorMatch.length > 0) {
      ambassadorRefCode = startPayload.toLowerCase();
    } else {
      const refUser = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.referralCode, startPayload.toUpperCase()))
        .limit(1);
      if (refUser.length > 0) {
        referredByUserId = refUser[0].id;
      }
    }
  }

  const wallet = walletService.generateWallet();
  const encryptedKey = await encryptPrivateKey(wallet.secretKey);
  const referralCode = generateReferralCode();

  await db.insert(users).values({
    id: userId,
    telegramUsername: username,
    firstName,
    lastName,
    walletAddress: wallet.publicKey,
    walletEncryptedKey: encryptedKey,
    referralCode,
    referredBy: referredByUserId,
    ambassadorReferralCode: ambassadorRefCode,
    onboardingComplete: false,
    defaultMode: mode,
  });

  await ensureBusinessSession(userId, mode);
  setSession(userId, { activeMode: mode, pendingStartPayload: undefined });

  if (mode === 'business') {
    await ctx.reply(
      `*Welcome to Zend Business!* 🚀\n\n` +
        `Your personal wallet was also created — switch to Personal mode anytime in Settings.`,
      { parse_mode: 'Markdown' },
    );
    await startBusinessOnboarding(ctx, userId);
    return;
  }

  await ctx.reply(
    `🟣 *Welcome to ZendPay*\n\n` +
      `Your Dollar savings + Naira bank account — inside Telegram.\n\n` +
      `✅ Account created automatically\n` +
      `✅ No password to remember\n` +
      `✅ Send naira to any Nigerian bank\n` +
      `✅ Receive naira via bank transfer\n\n` +
      `_You can also use Business mode for invoicing — switch anytime in Settings._`,
    { parse_mode: 'Markdown' },
  );
  await startOnboarding(ctx, userId);
}

export async function routeExistingUserStart(ctx: ZendContext, userId: string, firstName: string) {
  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = userRows[0];
  const mode = await getActiveMode(userId);

  setSession(userId, { activeMode: mode });

  if (mode === 'business') {
    const resumed = await resumeBusinessOnboardingIfNeeded(ctx, userId);
    if (resumed) return;

    const bizRows = await db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1);

    if (bizRows.length === 0) {
      await ctx.reply(`👋 Welcome back, ${firstName}!`);
      await startBusinessOnboarding(ctx, userId);
      return;
    }

    await ctx.reply(`👋 Welcome back, ${firstName}!`);
    await showBusinessMainMenu(ctx, userId);
    return;
  }

  if (!user.onboardingComplete) {
    await ctx.reply(`👋 Welcome back, ${firstName}!\n\nLet's finish setting up your account.`);
    await startOnboarding(ctx, userId);
    return;
  }

  await ctx.reply(`👋 Welcome back, ${firstName}!\n\nYour ZendPay account is ready.`, mainMenu);
}

export async function switchUserMode(ctx: ZendContext, userId: string, targetMode: ZendMode) {
  await setActiveMode(userId, targetMode);
  setSession(userId, { activeMode: targetMode, state: ConversationState.IDLE });

  if (targetMode === 'business') {
    const bizRows = await db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1);

    if (bizRows.length === 0 || !bizRows[0].onboardingComplete) {
      await ctx.reply('Switching to *Business* mode. Let\'s set up your business profile.', { parse_mode: 'Markdown' });
      await startBusinessOnboarding(ctx, userId);
      return;
    }

    await ctx.reply('Switched to *Business* mode.', { parse_mode: 'Markdown' });
    await showBusinessMainMenu(ctx, userId);
    return;
  }

  await ctx.reply('Switched to *Personal* mode.', { parse_mode: 'Markdown' });
  await ctx.reply('Menu:', mainMenu);
}

export function registerModeHandlers({ bot: b }: HandlerContext): void {
  b.action('mode_personal', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    const sess = getSession(userId);

    const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (existing.length > 0) {
      await switchUserMode(ctx as ZendContext, userId, 'personal');
      return;
    }

    await createUserWithMode(ctx as ZendContext, userId, 'personal', sess.pendingStartPayload);
  });

  b.action('mode_business', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    const sess = getSession(userId);

    const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (existing.length > 0) {
      await switchUserMode(ctx as ZendContext, userId, 'business');
      return;
    }

    await createUserWithMode(ctx as ZendContext, userId, 'business', sess.pendingStartPayload);
  });

  b.action('settings_switch_business', async (ctx) => {
    await ctx.answerCbQuery();
    await switchUserMode(ctx as ZendContext, ctx.from!.id.toString(), 'business');
  });

  b.action('settings_switch_personal', async (ctx) => {
    await ctx.answerCbQuery();
    await switchUserMode(ctx as ZendContext, ctx.from!.id.toString(), 'personal');
  });
}