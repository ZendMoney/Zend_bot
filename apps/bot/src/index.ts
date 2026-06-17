import './env.js';

import { bot } from './bot.js';
import { deps } from './deps.js';
import { mainMenu } from './keyboards/index.js';
import { registerAllHandlers } from './handlers/register.js';
import { run } from './launch/main.js';

registerAllHandlers({ bot, deps });

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ Something went wrong. Please try again or contact support.', mainMenu);
});

run().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});