import { Markup } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { ConversationState } from '@zend/shared';
import { mainMenu, cancelKeyboard } from '../keyboards/index.js';
import { showLoading, finishLoading } from '../lib/loading.js';
import { md } from '../lib/telegram.js';
import { isGroupChat, promptPrivateChat } from '../lib/group.js';
import { getSession, setSession } from '../session/store.js';
import { resolveActiveMode } from '../services/business/mode.js';
import { showBusinessSettings } from './business/settings.js';
import type { ZendContext } from '../session/types.js';
import type { HandlerContext } from './types.js';

export async function showSettings(ctx: ZendContext, userId: string) {
  const loading = await showLoading(ctx, 'Loading settings...');

  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

    if (user.length === 0) {
      await finishLoading(ctx, loading.message_id, 'Please run /start first.');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    const u = user[0];
    const autoSave = (u.autoSaveRateBps || 0) > 0 ? (u.autoSaveRateBps / 100).toFixed(0) + '%' : 'Off';

    const msg =
      `⚙️ *Settings*\n\n` +
      `👤 *Profile*\n` +
      `Name: ${md(u.firstName)} ${md(u.lastName || '')}\n\n` +
      `*Your Address:*\n` +
      `\`\`\`\n${u.walletAddress}\n\`\`\`\n\n` +
      `🔐 *Security*\n` +
      `Email: ${u.email || 'Not set'} ${u.emailVerified ? '✓' : ''}\n` +
      `Identity: ${u.pajSessionToken ? '✅ Verified' : '❌ Not verified'}\n` +
      `PIN: ${u.transactionPin ? 'Set ✅' : 'Not set'}\n\n` +
      `💰 *Preferences*\n` +
      `Auto-save: ${autoSave}`;

    // Build dynamic settings menu — hide items already done
    const buttons: any[] = [];
    buttons.push([{ text: '📋 Copy Address', copy_text: { text: u.walletAddress } } as any]);
    if (!u.email) {
      buttons.push([Markup.button.callback('📧 Add Email', 'settings_email')]);
    }
    if (!u.pajSessionToken) {
      buttons.push([Markup.button.callback('🔗 Link PAJ', 'settings_paj')]);
    }
    if (!u.transactionPin) {
      buttons.push([Markup.button.callback('🔢 Set PIN', 'settings_pin')]);
    } else {
      buttons.push([Markup.button.callback('🔢 Change PIN', 'settings_pin')]);
    }
    buttons.push([Markup.button.callback('🔑 Show Secret Code', 'export_key')]);
    buttons.push([Markup.button.callback('📅 Schedule Transfer', 'schedule_start')]);

    const activeMode = await resolveActiveMode(userId);
    if (activeMode === 'personal') {
      buttons.push([Markup.button.callback('🏢 Switch to Business Mode', 'settings_switch_business')]);
    } else {
      buttons.push([Markup.button.callback('👤 Switch to Personal Mode', 'settings_switch_personal')]);
    }

    await finishLoading(ctx, loading.message_id, msg, 'Markdown');
    await ctx.reply('Menu:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (err) {
    console.error('Settings error:', err);
    await finishLoading(ctx, loading.message_id, '❌ Could not load settings. Please try again.');
    await ctx.reply('Menu:', mainMenu);
  }
}



export function registerSettingsHandlers({ bot: b }: HandlerContext): void {
b.hears('⚙️ Settings', async (ctx) => {
  if (isGroupChat(ctx)) {
    await promptPrivateChat(ctx, 'access Settings');
    return;
  }
  const userId = ctx.from.id.toString();
  const mode = await resolveActiveMode(userId);
  if (mode === 'business') {
    await showBusinessSettings(ctx as ZendContext, userId);
    return;
  }
  await showSettings(ctx, userId);
});

b.action('settings_paj', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  setSession(userId, { state: ConversationState.AWAITING_EMAIL });

  await ctx.editMessageText(
    `🔗 *Link PAJ Account*\n\n` +
    `Enter your email or phone (with country code):\n` +
    `Example: user@email.com or +2348012345678`
  );

  await ctx.reply('Waiting for your input...', cancelKeyboard);
});

b.action('settings_email', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  setSession(userId, { state: ConversationState.AWAITING_EMAIL });

  await ctx.editMessageText(
    `📧 *Add / Change Email*\n\n` +
    `Enter your email address:\n` +
    `Example: user@email.com`
  );

  await ctx.reply('Waiting for your input...', cancelKeyboard);
});

b.action('settings_pin', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();

  setSession(userId, { state: ConversationState.AWAITING_PIN });

  await ctx.editMessageText(
    `🔢 *Set / Change Transaction PIN*\n\n` +
    `Enter a new 4-digit PIN for transaction security:\n` +
    `Example: 1234`
  );

  const waitMsg = await ctx.reply('Waiting for your input...', cancelKeyboard);
  getSession(userId).lastBotMessageId = waitMsg.message_id;
});
}
