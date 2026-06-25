import { resolveActiveMode } from '../../services/business/mode.js';
import { businessMainMenu, BUSINESS_REPLY_KEYBOARD_BUTTONS } from '../../keyboards/business.js';
import { isGroupChat, promptPrivateChat } from '../../lib/group.js';
import { handleBusinessOnboardingText } from './onboarding.js';
import { showBusinessMainMenu } from './main-menu.js';
import { showBusinessSettings } from './settings.js';
import { registerBusinessOnboardingActions } from './onboarding.js';
import { registerModeHandlers } from './mode.js';
import type { HandlerContext } from '../types.js';
import type { ZendContext } from '../../session/types.js';

export function registerBusinessHandlers(ctx: HandlerContext): void {
  registerModeHandlers(ctx);
  registerBusinessOnboardingActions(ctx);

  const { bot: b } = ctx;

  b.hears('🧾 Generate Invoice', async (ctx) => {
    if (isGroupChat(ctx)) {
      await promptPrivateChat(ctx, 'generate invoices');
      return;
    }
    const mode = await resolveActiveMode(ctx.from.id.toString());
    if (mode !== 'business') return;
    await ctx.reply('🧾 Invoice generation is coming soon. Stay tuned!', businessMainMenu);
  });

  b.hears('📋 My Invoices', async (ctx) => {
    if (isGroupChat(ctx)) return;
    const mode = await resolveActiveMode(ctx.from.id.toString());
    if (mode !== 'business') return;
    await ctx.reply('📋 My Invoices is coming soon.', businessMainMenu);
  });

  b.hears('💰 My Balance', async (ctx) => {
    if (isGroupChat(ctx)) return;
    const mode = await resolveActiveMode(ctx.from.id.toString());
    if (mode !== 'business') return;
    await ctx.reply('💰 Business balance view is coming soon.', businessMainMenu);
  });

  b.hears('📊 Analytics', async (ctx) => {
    if (isGroupChat(ctx)) return;
    const mode = await resolveActiveMode(ctx.from.id.toString());
    if (mode !== 'business') return;
    await ctx.reply('📊 Analytics is coming soon.', businessMainMenu);
  });

  b.hears('❓ Help', async (ctx) => {
    const mode = await resolveActiveMode(ctx.from.id.toString());
    if (mode !== 'business') return;
    await ctx.reply(
      '*Zend Business Help*\n\n' +
        '• Generate professional invoices for your clients\n' +
        '• Collect payments in NGN or crypto\n' +
        '• Get settled to your bank or USDC wallet\n\n' +
        'Switch to Personal mode in Settings for wallet features.',
      { parse_mode: 'Markdown', ...businessMainMenu },
    );
  });
}

/** Handle business-mode text before the personal text router. Returns true if handled. */
export async function tryHandleBusinessText(ctx: ZendContext, userId: string, text: string): Promise<boolean> {
  const mode = await resolveActiveMode(userId);
  if (mode !== 'business') return false;

  if (BUSINESS_REPLY_KEYBOARD_BUTTONS.has(text)) return true;

  return handleBusinessOnboardingText(ctx, userId, text);
}

export { showBusinessMainMenu };