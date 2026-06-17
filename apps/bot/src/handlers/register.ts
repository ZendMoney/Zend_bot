import type { HandlerContext } from './types.js';

/**
 * Central handler registration — grows as domains migrate out of index.ts.
 * Phase 4+: registerStartHandlers, registerSendHandlers, registerBillsHandlers, etc.
 */
export function registerAllHandlers(_ctx: HandlerContext): void {
  // Handlers still live in index.ts during Phase 1–3 migration.
}