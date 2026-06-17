import type { SendFeeInfo } from '../utils/fees.js';

/** Functions still defined in index.ts during migration — bound before launch */
export interface LaunchRuntime {
  calculateSendFee: (
    transferUsdt: number,
    userWalletAddress: string,
    userId?: string
  ) => Promise<SendFeeInfo>;
  executeSendCore: (
    userId: string,
    txData: Record<string, unknown>
  ) => Promise<{ success: boolean; txId?: string; solanaTxHash?: string; error?: string }>;
  getPAJRates: () => Promise<{ onRampRate: number; offRampRate: number }>;
  checkMilestones: (userId: string, notifyFn: (text: string) => Promise<unknown>) => Promise<void>;
}

let runtime: LaunchRuntime | null = null;

export function setLaunchRuntime(r: LaunchRuntime): void {
  runtime = r;
}

export function getLaunchRuntime(): LaunchRuntime {
  if (!runtime) {
    throw new Error('Launch runtime not initialized — call setLaunchRuntime() before run()');
  }
  return runtime;
}