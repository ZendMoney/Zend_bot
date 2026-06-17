import type { HandlerContext } from './types.js';
import { registerBalanceHandlers } from './balance.js';
import { registerStartHandlers } from './start.js';
import { registerSettingsHandlers } from './settings.js';
import { registerHelpHandlers } from './help.js';
import { registerBillsHandlers } from './bills.js';
import { registerAdminMenuHandlers } from './admin-menu.js';
import { registerSendHandlers } from './send.js';
import { registerSwapHandlers } from './swap.js';
import { registerReceiveHandlers } from './receive.js';
import { registerHistoryHandlers } from './history.js';
import { registerBulkSendHandlers } from './bulk-send.js';
import { registerOnrampHandlers } from './onramp.js';
import { registerTextRouter } from './text/router.js';

/** Handlers that must register before the text router (keyboard pass-through). */
export function registerPreTextHandlers(ctx: HandlerContext): void {
  registerBalanceHandlers(ctx);
  registerStartHandlers(ctx);
}

/** Text state machine — must run after pre-text hears, before post-text hears. */
export { registerTextRouter };

/** Handlers registered after the text router (rely on next() for reply keyboards). */
export function registerPostTextHandlers(ctx: HandlerContext): void {
  registerSettingsHandlers(ctx);
  registerHelpHandlers(ctx);
  registerBillsHandlers(ctx);
  registerAdminMenuHandlers(ctx);
  registerSendHandlers(ctx);
  registerSwapHandlers(ctx);
  registerReceiveHandlers(ctx);
  registerHistoryHandlers(ctx);
  registerBulkSendHandlers(ctx);
  registerOnrampHandlers(ctx);
}

export function registerAllHandlers(ctx: HandlerContext): void {
  registerPreTextHandlers(ctx);
  registerTextRouter(ctx);
  registerPostTextHandlers(ctx);
}