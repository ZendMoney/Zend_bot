import { Markup } from 'telegraf';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { ConversationState } from '@zend/shared';
import { airbillsClient } from '../deps.js';
import { mainMenu, cancelKeyboard, billsMenu } from '../keyboards/index.js';
import { showLoading, finishLoading } from '../lib/loading.js';
import { getSession, setSession } from '../session/store.js';
import {
  buyAirtime, buyData, buyElectricity, buyCable,
  NETWORKS, DISCOS, CABLE_PROVIDERS, isDemoMode,
} from '../services/bills/index.js';
import {
  purchaseAirtime as airbillsBuyAirtime,
  purchaseData as airbillsBuyData,
  purchaseElectricity as airbillsBuyElectricity,
  purchaseCable as airbillsBuyCable,
} from '../services/airbills/index.js';
import type { HandlerContext } from './types.js';

export function registerBillsHandlers({ bot: b }: HandlerContext): void {
b.hears('💳 Bills', async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }
  setSession(userId, { state: ConversationState.BILL_SELECT_TYPE });
  await ctx.reply(
    `💳 *Bills & Airtime*\n\n` +
    `Pay for airtime, data, electricity, and cable TV with your USDT balance.\n\n` +
    `Select a service:`,
    { parse_mode: 'Markdown', ...billsMenu }
  );
});

b.hears('📱 Airtime', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = getSession(userId);
  session.billData = { type: 'airtime' };
  setSession(userId, session);

  const rows = NETWORKS.map((n) => [Markup.button.callback(n.name, `bill_airtime_${n.code}`)]);
  await ctx.reply('📱 Select network:', Markup.inlineKeyboard(rows));
});

b.hears('🌐 Data', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = getSession(userId);
  session.billData = { type: 'data' };
  setSession(userId, session);

  const rows = NETWORKS.map((n) => [Markup.button.callback(n.name, `bill_data_${n.code}`)]);
  await ctx.reply('🌐 Select network:', Markup.inlineKeyboard(rows));
});

b.hears('⚡ Electricity', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = getSession(userId);
  session.billData = { type: 'electricity' };
  setSession(userId, session);

  const rows = DISCOS.map((d) => [Markup.button.callback(d.name, `bill_electricity_${d.code}`)]);
  await ctx.reply('⚡ Select electricity distribution company:', Markup.inlineKeyboard(rows));
});

b.hears('📺 Cable TV', async (ctx) => {
  const userId = ctx.from.id.toString();
  const session = getSession(userId);
  session.billData = { type: 'cable' };
  setSession(userId, session);

  const rows = CABLE_PROVIDERS.map((p) => [Markup.button.callback(p.name, `bill_cable_${p.code}`)]);
  await ctx.reply('📺 Select cable TV provider:', Markup.inlineKeyboard(rows));
});

// ─── Airtime Network Selected ───
b.action(/^bill_airtime_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const network = ctx.match![1];
  const session = getSession(userId);
  session.billData = { ...session.billData, type: 'airtime', network };
  session.state = ConversationState.BILL_ENTER_PHONE;
  setSession(userId, session);
  await ctx.editMessageText(`📱 ${network.toUpperCase()} Airtime\n\nEnter the phone number:`);
  await ctx.reply('Enter recipient phone number:', cancelKeyboard);
});

// ─── Data Network Selected ───
b.action(/^bill_data_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const network = ctx.match![1];
  const session = getSession(userId);
  session.billData = { ...session.billData, type: 'data', network };
  session.state = ConversationState.BILL_ENTER_PHONE;
  setSession(userId, session);
  await ctx.editMessageText(`🌐 ${network.toUpperCase()} Data\n\nEnter the phone number:`);
  await ctx.reply('Enter recipient phone number:', cancelKeyboard);
});

// ─── Data Plan Selected ───
b.action(/^bill_plan_(.+)_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const planId = ctx.match![1];
  const planAmount = parseInt(ctx.match![2], 10);
  const session = getSession(userId);
  session.billData = airbillsClient
    ? { ...session.billData, planId, planAmount }
    : { ...session.billData, planCode: planId, planAmount };
  setSession(userId, session);

  const usdtAmount = planAmount / 1400;
  await ctx.editMessageText(
    `🌐 *Confirm Data Purchase*\n\n` +
    `Phone: ${session.billData?.phone}\n` +
    `Plan: ${planId}\n` +
    `Amount: ₦${planAmount.toLocaleString()}\n` +
    `≈ ${usdtAmount.toFixed(4)} USDT`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm', 'bill_confirm')],
        [Markup.button.callback('❌ Cancel', 'cancel_send')],
      ]),
    }
  );
});

// ─── Electricity Disco Selected ───
b.action(/^bill_electricity_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const disco = ctx.match![1];
  const session = getSession(userId);
  session.billData = { ...session.billData, type: 'electricity', disco };
  session.state = ConversationState.BILL_ENTER_METER;
  setSession(userId, session);
  await ctx.editMessageText(`⚡ ${disco.replace(/-/g, ' ').toUpperCase()}\n\nEnter your meter number:`);
  await ctx.reply('Enter meter number:', cancelKeyboard);
});

// ─── Cable Provider Selected ───
b.action(/^bill_cable_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const provider = ctx.match![1];
  const session = getSession(userId);
  session.billData = { ...session.billData, type: 'cable', provider };
  session.state = ConversationState.BILL_ENTER_SMARTCARD;
  setSession(userId, session);
  await ctx.editMessageText(`📺 ${provider.toUpperCase()}\n\nEnter your smart card number:`);
  await ctx.reply('Enter smart card number:', cancelKeyboard);
});

// ─── Confirm Bill Purchase ───
b.action('bill_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id.toString();
  const session = getSession(userId);
  const bill = session.billData;

  if (!bill) {
    await ctx.editMessageText('❌ Session expired. Please start over.');
    await ctx.reply('Menu:', mainMenu);
    setSession(userId, { state: ConversationState.IDLE });
    return;
  }

  const loading = await showLoading(ctx, 'Processing your purchase...');

  try {
    let result;

    // Use AirBills when configured, otherwise fall back to VTpass
    if (airbillsClient) {
      if (bill.type === 'airtime' && bill.phone && bill.amount && bill.network) {
        result = await airbillsBuyAirtime(airbillsClient, userId, bill.phone, bill.amount, bill.network);
      } else if (bill.type === 'data' && bill.phone && bill.planAmount && bill.network) {
        result = await airbillsBuyData(
          airbillsClient, userId, bill.phone, bill.planAmount, bill.network, bill.planId || bill.planCode
        );
      } else if (bill.type === 'electricity' && bill.meterNumber && bill.amount && bill.disco) {
        result = await airbillsBuyElectricity(airbillsClient, userId, bill.meterNumber, bill.amount, bill.disco);
      } else if (bill.type === 'cable' && bill.smartCardNumber && bill.amount && bill.provider) {
        result = await airbillsBuyCable(airbillsClient, userId, bill.smartCardNumber, bill.amount, bill.provider);
      } else {
        throw new Error('Invalid bill data');
      }
    } else {
      // Fallback to VTpass
      if (bill.type === 'airtime' && bill.phone && bill.amount && bill.network) {
        result = await buyAirtime(userId, { phone: bill.phone, amount: bill.amount, network: bill.network });
      } else if (bill.type === 'data' && bill.phone && bill.planCode && bill.network && bill.planAmount) {
        result = await buyData(userId, { phone: bill.phone, planCode: bill.planCode, network: bill.network }, bill.planAmount);
      } else if (bill.type === 'electricity' && bill.meterNumber && bill.amount && bill.disco) {
        result = await buyElectricity(userId, { meterNumber: bill.meterNumber, amount: bill.amount, disco: bill.disco, meterType: bill.meterType || 'prepaid' });
      } else if (bill.type === 'cable' && bill.smartCardNumber && bill.amount && bill.provider) {
        result = await buyCable(userId, { smartCardNumber: bill.smartCardNumber, bouquetCode: bill.bouquetCode || 'basic', provider: bill.provider }, bill.amount);
      } else {
        throw new Error('Invalid bill data');
      }
    }

    if (result.success) {
      let msg = `✅ *Purchase Successful!*\n\n${result.message}`;
      if (result.token) msg += `\n\n🔑 *Token:* \`${result.token}\``;
      if (result.units) msg += `\n⚡ *Units:* ${result.units}`;
      if (result.commission) msg += `\n💰 *Commission:* ₦${result.commission}`;
      if (isDemoMode()) msg += `\n\n_(Demo mode — no real transaction occurred)_`;
      await finishLoading(ctx, loading.message_id, msg, 'Markdown');
    } else {
      await finishLoading(ctx, loading.message_id, `❌ Purchase failed: ${result.message}`);
    }
  } catch (err: any) {
    console.error('[Bill] Purchase error:', err);
    await finishLoading(ctx, loading.message_id, '❌ Could not complete purchase. Please try again.');
  }

  setSession(userId, { state: ConversationState.IDLE });
  await ctx.reply('Menu:', mainMenu);
});
}
