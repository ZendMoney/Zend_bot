import { Markup } from 'telegraf';

export const adminMainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('📊 Overview', 'admin_page:overview')],
  [Markup.button.callback('👤 Users', 'admin_page:users'), Markup.button.callback('🧑‍🎓 Ambassadors', 'admin_page:ambassadors')],
  [Markup.button.callback('🚨 Suspensions', 'admin_page:suspensions'), Markup.button.callback('💰 Fees & Revenue', 'admin_page:fees')],
  [Markup.button.callback('🎯 Ref Links', 'admin_page:ambassador_refs'), Markup.button.callback('🔍 Search', 'admin_page:search')],
  [Markup.button.callback('⚙️ Features', 'admin_page:features'), Markup.button.callback('📝 Feedback', 'admin_page:feedback')],
]);

export const adminSearchKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('🔎 Search Transaction', 'admin_search:txn')],
  [Markup.button.callback('👤 Search User', 'admin_search:user')],
  [Markup.button.callback('◀️ Back', 'admin_back')],
]);