import { Markup } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { WalletService } from '@zend/solana';
import { PAJClient } from '@zend/paj-client';
import { generateReference } from '@zend/shared';
import type { ZendContext } from '../middleware/session.js';

// Services (would be injected in real app)
const walletService = new WalletService(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  Buffer.from(process.env.FEE_PAYER_KEY || '', 'base64')
);

const pajClient = new PAJClient({
  apiKey: process.env.PAJ_API_KEY || '',
  apiSecret: process.env.PAJ_API_SECRET || '',
  baseUrl: process.env.PAJ_BASE_URL || 'https://api.paj.cash',
});

export async function startHandler(ctx: ZendContext) {
  const telegramId = ctx.from!.id.toString();
  const username = ctx.from!.username;
  const firstName = ctx.from!.first_name;
  const lastName = ctx.from!.last_name;

  // Check if user already exists
  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, telegramId),
  });

  if (existingUser) {
    // Returning user — show main menu
    await ctx.reply(
      `👋 Welcome back, ${firstName}!\n\n` +
      `💰 Balance: Check with /balance\n` +
      `📤 Send: Use /send or just type naturally`,
      mainMenuKeyboard()
    );
    return;
  }

  // New user — create wallet
  await ctx.reply(
    `🟣 Welcome to Zend\n\n` +
    `Your Solana wallet + Naira bank account — inside Telegram.\n\n` +
    `✅ No seed phrase to remember\n` +
    `✅ Send naira to any Nigerian bank\n` +
    `✅ Receive naira via bank transfer\n` +
    `✅ Type, speak, or snap a photo`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🚀 Create My Wallet', 'create_wallet')],
    ])
  );
}

// Handle wallet creation callback
export async function handleCreateWallet(ctx: ZendContext) {
  const telegramId = ctx.from!.id.toString();
  const firstName = ctx.from!.first_name;
  const username = ctx.from!.username;

  await ctx.answerCbQuery('Creating your wallet...');

  // Generate Solana wallet
  const wallet = walletService.generateWallet();

  // Encrypt private key (simplified — use KMS in production)
  const encryptedKey = Buffer.from(wallet.secretKey).toString('base64');

  // Provision PAJ virtual account
  let virtualAccount = null;
  try {
    virtualAccount = await pajClient.provisionVirtualAccount(wallet.publicKey);
  } catch (err) {
    console.error('Failed to provision PAJ account:', err);
  }

  // Generate referral code
  const referralCode = `ref_${telegramId.slice(-8)}`;

  // Save user to database
  await db.insert(users).values({
    id: telegramId,
    telegramUsername: username,
    firstName,
    walletAddress: wallet.publicKey,
    walletEncryptedKey: encryptedKey,
    virtualAccount: virtualAccount ? {
      bankCode: virtualAccount.bankCode,
      bankName: virtualAccount.bankName,
      accountNumber: virtualAccount.accountNumber,
      accountName: virtualAccount.accountName,
    } : null,
    referralCode,
  });

  // Show wallet created screen
  const virtualAccountText = virtualAccount
    ? `\n🏦 *${virtualAccount.bankName}*\n` +
      `🔢 \`${virtualAccount.accountNumber}\`\n` +
      `👤 *${virtualAccount.accountName}*\n\n` +
      `💡 Save this account number in your bank app. Anyone can send naira here and USDT will appear automatically.`
    : '\n⚠️ NGN account setup pending. Try /buy later.';

  await ctx.editMessageText(
    `✅ *Wallet Created!*\n\n` +
    `Your Solana address:\n` +
    `\`${wallet.publicKey}\`\n\n` +
    `Your NGN receiving account:${virtualAccountText}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💰 Check Balance', 'menu_balance')],
        [Markup.button.callback('📤 Send Money', 'menu_send')],
      ]),
    }
  );
}

function mainMenuKeyboard() {
  return Markup.keyboard([
    ['💰 Balance', '📤 Send'],
    ['💵 Buy NGN', '💴 Sell NGN'],
    ['🔄 Swap', '🏦 Vault'],
    ['📋 History', '⚙️ Settings'],
  ]).resize();
}
