import type { Telegraf } from 'telegraf';
import type { BotDeps } from '../deps.js';
import type { ZendContext } from '../session/types.js';

/** Context passed to handler registration functions during the index.ts migration */
export interface HandlerContext {
  bot: Telegraf<ZendContext>;
  deps: BotDeps;
}