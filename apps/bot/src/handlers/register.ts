import type { HandlerContext } from './types.js';
import { registerBalanceHandlers } from './balance.js';
import { registerStartHandlers } from './start.js';
import { registerMyrefHandlers } from './myref.js';
import { registerAdminPanelHandlers } from './admin/panel.js';
import { registerAdminPushHandlers } from './admin/push.js';
import { registerWalletHandlers } from './wallet.js';
import { registerVoiceHandlers } from './voice.js';
import { registerPhotoHandlers } from './photo.js';
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
import { registerScheduleHandlers } from './schedule/index.js';
import { registerBridgeHandlers } from './bridge.js';
import { registerWithdrawHandlers } from './withdraw.js';
import { registerTextRouter } from './text/router.js';
import { registerBusinessHandlers } from './business/register.js';

/** Handlers that must register before the text router (keyboard pass-through). */
export function registerPreTextHandlers(ctx: HandlerContext): void {
  registerBalanceHandlers(ctx);
  registerStartHandlers(ctx);
  registerBusinessHandlers(ctx);
  registerMyrefHandlers(ctx);
  registerAdminPanelHandlers(ctx);
  registerAdminPushHandlers(ctx);
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
  registerWalletHandlers(ctx);
  registerVoiceHandlers(ctx);
  registerPhotoHandlers(ctx);
  registerTextRouter(ctx);
  registerScheduleHandlers(ctx);
  registerBridgeHandlers(ctx);
  registerWithdrawHandlers(ctx);
  registerPostTextHandlers(ctx);
}