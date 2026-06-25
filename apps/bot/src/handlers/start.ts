import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { ConversationState } from '@zend/shared';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { setSession } from '../session/store.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';
import { showModePicker, routeExistingUserStart } from './business/mode.js';

export async function startOnboarding(ctx: ZendContext, userId: string) {
  setSession(userId, { state: ConversationState.ONBOARDING_AWAITING_EMAIL, activeMode: 'personal' });
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
    const firstName = ctx.from.first_name;
    const startPayload = ctx.message?.text?.split(' ')[1]?.trim() || '';

    const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (existing.length > 0) {
      await routeExistingUserStart(ctx as ZendContext, userId, firstName);
      return;
    }

    await showModePicker(ctx as ZendContext, userId, startPayload || undefined);
  });
}