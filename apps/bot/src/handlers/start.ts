import { db, users, ambassadorApplications } from '@zend/db';
import { eq, and } from 'drizzle-orm';
import { ConversationState } from '@zend/shared';
import { walletService } from '../deps.js';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { generateReferralCode } from '../lib/ids.js';
import { encryptPrivateKey } from '../utils/wallet.js';
import { setSession } from '../session/store.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function startOnboarding(ctx: ZendContext, userId: string) {
  setSession(userId, { state: ConversationState.ONBOARDING_AWAITING_EMAIL });
  await ctx.reply(
    `🔐 *Let's Secure Your Account*\n\n` +
    `Before you start, we need to verify your identity and set a transaction PIN.\n\n` +
    `Step 1 of 3: Enter your email address\n` +
    `We'll send a verification code via PAJ.`,
    { parse_mode: 'Markdown', ...cancelKeyboard }
  );
}

export function registerStartHandlers({ bot: b }: HandlerContext): void {
  b.command('start', async (ctx) => {
    const userId = ctx.from.id.toString();
    const username = ctx.from.username;
    const firstName = ctx.from.first_name;
    const lastName = ctx.from.last_name || '';

    const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (existing.length > 0) {
      if (!existing[0].onboardingComplete) {
        await ctx.reply(`👋 Welcome back, ${firstName}!\n\nLet's finish setting up your account.`);
        await startOnboarding(ctx, userId);
        return;
      }
      await ctx.reply(`👋 Welcome back, ${firstName}!\n\nYour Zend account is ready.`, mainMenu);
      return;
    }

    const startPayload = ctx.message?.text?.split(' ')[1]?.trim() || '';
    let ambassadorRefCode: string | undefined;
    let referredByUserId: string | undefined;

    if (startPayload) {
      const ambassadorMatch = await db.select().from(ambassadorApplications)
        .where(and(
          eq(ambassadorApplications.customReferralCode, startPayload.toLowerCase()),
          eq(ambassadorApplications.status, 'confirmed')
        )).limit(1);
      if (ambassadorMatch.length > 0) {
        ambassadorRefCode = startPayload.toLowerCase();
      } else {
        const refUser = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, startPayload.toUpperCase())).limit(1);
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
    });

    await ctx.reply(
      `🟣 *Welcome to Zend*\n\n` +
      `Your Dollar savings + Naira bank account — inside Telegram.\n\n` +
      `✅ Account created automatically\n` +
      `✅ No password to remember\n` +
      `✅ Send naira to any Nigerian bank\n` +
      `✅ Receive naira via bank transfer`,
      { parse_mode: 'Markdown' }
    );

    await startOnboarding(ctx, userId);
  });
}