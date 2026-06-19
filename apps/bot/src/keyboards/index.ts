import { Markup } from 'telegraf';

export const mainMenu = Markup.keyboard([
  ['💰 Balance', '📤 Send', '🔄 Swap'],
  ['📥 Receive', '💳 Bills', '📋 History'],
  ['📦 Bulk Send', '📅 Schedule'],
  ['⚙️ Settings', '📖 How to Use', '✨ Features'],
  ['📝 Feedback', '❓ Help'],
]).resize();

export const cancelKeyboard = Markup.keyboard([['❌ Cancel']]).resize();

export const billsMenu = Markup.keyboard([
  ['📱 Airtime', '🌐 Data'],
  ['⚡ Electricity', '📺 Cable TV'],
  ['🔙 Back to Menu'],
]).resize();

export const billsBackKeyboard = Markup.keyboard([['🔙 Back to Menu']]).resize();

export const adminMenu = Markup.keyboard([
  ['📊 Stats', '👤 Users'],
  ['💸 Transactions', '🏦 Bank Accounts'],
  ['📅 Scheduled', '🤖 QVAC Status'],
  ['🔙 Back to Menu'],
]).resize();

/**
 * Reply-keyboard labels delegated to bot.hears() — must not be swallowed by the text handler.
 * Keep in sync with bot.hears() registrations.
 */
export const REPLY_KEYBOARD_BUTTONS = new Set([
  // Main menu
  '💰 Balance', '📤 Send', '📥 Receive', '🔄 Swap', '💳 Bills', '📋 History',
  '⚙️ Settings', '📦 Bulk Send', '📅 Schedule', '📖 How to Use', '✨ Features',
  '📝 Feedback', '❓ Help', '💵 Add Naira', '💴 Cash Out',
  // Bills submenu
  '📱 Airtime', '🌐 Data', '⚡ Electricity', '📺 Cable TV',
  // Admin submenu
  '📊 Stats', '👤 Users', '💸 Transactions', '🏦 Bank Accounts', '📅 Scheduled', '🤖 QVAC Status',
  // Shared
  '🔙 Back to Menu',
]);