import { db, botFeatures } from '@zend/db';
import { eq } from 'drizzle-orm';
import { AUDD_ENABLED } from '../utils/flags.js';

let _botFeaturesCache: any[] | null = null;
let _botFeaturesCacheTime = 0;

export function invalidateBotFeaturesCache(): void {
  _botFeaturesCache = null;
  _botFeaturesCacheTime = 0;
}

export async function getBotFeatures(): Promise<any[]> {
  if (_botFeaturesCache && Date.now() - _botFeaturesCacheTime < 300000) {
    return _botFeaturesCache;
  }
  try {
    const rows = await db.select().from(botFeatures).where(eq(botFeatures.isActive, true));
    _botFeaturesCache = rows;
    _botFeaturesCacheTime = Date.now();
    return rows;
  } catch (err) {
    console.log('[Features] DB fetch failed, using cache/empty');
    return _botFeaturesCache || [];
  }
}

export async function seedBotFeatures(): Promise<void> {
  try {
    const features = [
      { key: 'balance', name: 'Check Balance', description: 'Dollars (USDT/USDC) and SOL with live Naira rates', category: 'payment', sortOrder: 1 },
      { key: 'add_naira', name: 'Add Naira', description: 'Bank transfer to a virtual account, get Dollars in your wallet', category: 'payment', sortOrder: 2 },
      { key: 'receive', name: 'Receive Money', description: 'Crypto address for direct deposit + virtual bank account for Naira', category: 'payment', sortOrder: 3 },
      { key: 'swap', name: 'Convert Currency', description: AUDD_ENABLED ? 'Exchange SOL ↔ USDT ↔ USDC ↔ AUDD' : 'Exchange SOL ↔ USDT ↔ USDC', category: 'payment', sortOrder: 4 },
      { key: 'deposit_crypto', name: 'Deposit from Other Apps', description: 'Send crypto from any wallet → receive in ZendPay via NEAR Intents', category: 'payment', sortOrder: 5 },
      { key: 'history', name: 'Transaction History', description: 'View all past transactions', category: 'info', sortOrder: 6 },
      { key: 'voice', name: 'Voice Commands', description: 'Send a voice note to execute commands', category: 'info', sortOrder: 7 },
      { key: 'bills', name: 'Bills & Utilities', description: 'Buy airtime, data, electricity and cable TV subscriptions', category: 'payment', sortOrder: 8 },
      { key: 'settings', name: 'Settings', description: 'PIN, language, auto-save, PAJ linking, wallet export', category: 'settings', sortOrder: 9 },
      { key: 'help', name: 'Help', description: 'Get support and join the ZendPay community', category: 'info', sortOrder: 10 },
      { key: 'how_to_use', name: 'How to Use', description: 'Step-by-step guide to using ZendPay', category: 'info', sortOrder: 11 },
      { key: 'features', name: 'Features', description: 'Explore everything ZendPay can do', category: 'info', sortOrder: 12 },
      { key: 'feedback', name: 'Feedback', description: 'Share ideas, report bugs, or ask for help', category: 'info', sortOrder: 13 },
    ];

    const existingRows = await db.select({ key: botFeatures.key }).from(botFeatures);
    const existingKeys = new Set(existingRows.map(r => r.key));

    let inserted = 0;
    for (const f of features) {
      if (existingKeys.has(f.key)) continue;
      await db.insert(botFeatures).values(f);
      inserted++;
    }

    if (inserted > 0) {
      console.log('[Features] Seeded', inserted, 'new features (total expected:', features.length, ')');
    }
  } catch (err) {
    console.error('[Features] Seed failed:', err);
  }
}