import { Markup } from 'telegraf';

export const businessMainMenu = Markup.keyboard([
  ['🧾 Generate Invoice', '📋 My Invoices'],
  ['💰 My Balance', '📊 Analytics'],
  ['⚙️ Settings', '❓ Help'],
]).resize();

export const modePickerKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('👤 Personal — wallet & payments', 'mode_personal')],
  [Markup.button.callback('🏢 Business — invoicing & collections', 'mode_business')],
]);

export const BUSINESS_REPLY_KEYBOARD_BUTTONS = new Set([
  '🧾 Generate Invoice',
  '📋 My Invoices',
  '💰 My Balance',
  '📊 Analytics',
  '❓ Help',
]);