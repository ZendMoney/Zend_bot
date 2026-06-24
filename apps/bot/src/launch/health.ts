import { checkConnection } from '@zend/db';
import { getNearIntentsClient } from '@zend/near-intents-client';
import type { PAJClient } from '@zend/paj-client';
import type { AirbillsClient } from '@zend/airbills-client';
import { validateFeeWallet, ZEND_FEE_NORMAL_BPS, ZEND_FEE_FUNDED_BPS } from '../utils/fees.js';
import { MESSAGE_TTL_MS, PIN_TTL_MS } from '../middleware/auto-delete.js';
import { checkAirbillsHealth } from '../services/airbills/index.js';

export interface HealthReport {
  database: boolean;
  paj: boolean;
  nearIntents: boolean;
  airbills: boolean | 'not_configured';
  feeWallet: string | null;
}

export async function runStartupHealthChecks(deps: {
  getPAJClient: () => Promise<PAJClient | null>;
  airbillsClient: AirbillsClient | null;
}): Promise<HealthReport> {
  const report: HealthReport = {
    database: false,
    paj: false,
    nearIntents: false,
    airbills: 'not_configured',
    feeWallet: null,
  };

  report.database = await checkConnection();
  if (!report.database) {
    console.error('❌ Database connection failed.');
    return report;
  }
  console.log('✅ Database connected');
  console.log(
    `🧹 Auto-delete: bot + user msgs in DMs after ${MESSAGE_TTL_MS / 60000} min, PIN/OTP after ${PIN_TTL_MS / 60000} min`
  );

  const pajClient = await deps.getPAJClient();
  if (pajClient) {
    try {
      const rates = await pajClient.getAllRates();
      console.log('✅ PAJ connected — On-ramp:', rates.onRampRate.rate, 'Off-ramp:', rates.offRampRate.rate);
      report.paj = true;
    } catch (err) {
      console.warn('⚠️  PAJ rate check failed:', err);
    }
  } else {
    console.warn('⚠️  PAJ not configured');
  }

  const nearIntents = getNearIntentsClient();
  if (nearIntents) {
    try {
      const tokens = await nearIntents.getTokens();
      console.log('🔗 NEAR Intents tokens loaded:', tokens.length);
      report.nearIntents = true;
    } catch (err: any) {
      console.warn('⚠️  NEAR Intents tokens check failed:', err.message);
    }
  } else {
    console.warn('⚠️  NEAR Intents not configured');
  }

  report.feeWallet = validateFeeWallet();
  if (report.feeWallet) {
    console.log('💰 Fee collection wallet:', report.feeWallet);
    console.log(`📐 Fee rates: ${ZEND_FEE_NORMAL_BPS / 100}% normal / max(${ZEND_FEE_FUNDED_BPS / 100}%, gas+$flat) when sponsored`);
  }

  if (deps.airbillsClient) {
    const airbillsOk = await checkAirbillsHealth(deps.airbillsClient);
    report.airbills = airbillsOk;
    if (airbillsOk) {
      console.log('✅ AirBills API connected');
    } else {
      const keyHint = process.env.AIRBILLS_API_KEY?.trim()
        ? `key ends …${process.env.AIRBILLS_API_KEY.trim().slice(-4)}`
        : 'no key set';
      console.warn(`⚠️  AirBills API key invalid or unreachable (${keyHint}) — bill payments will fail until fixed`);
    }
  } else {
    console.warn('⚠️  AirBills not configured — bill payments use VTpass demo fallback');
  }

  return report;
}