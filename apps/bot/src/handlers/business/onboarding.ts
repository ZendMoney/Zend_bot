import { Markup } from 'telegraf';
import { db, businesses, businessWallets, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { BusinessFlow, BusinessOnboardingStep, ConversationState, NIGERIAN_BANKS } from '@zend/shared';

import { cancelKeyboard } from '../../keyboards/index.js';
import { setSession } from '../../session/store.js';
import { updateBusinessSession } from '../../services/business/session.js';
import { verifyBankAccount } from '../../services/paj.js';
import type { ZendContext } from '../../session/types.js';
import { showBusinessMainMenu } from './main-menu.js';

const STEP_LABELS: Record<BusinessOnboardingStep, string> = {
  [BusinessOnboardingStep.BUSINESS_NAME]: 'business name',
  [BusinessOnboardingStep.BUSINESS_EMAIL]: 'business email',
  [BusinessOnboardingStep.BUSINESS_PHONE]: 'phone number',
  [BusinessOnboardingStep.BUSINESS_LOGO]: 'logo upload',
  [BusinessOnboardingStep.BANK_NAME]: 'bank selection',
  [BusinessOnboardingStep.BANK_ACCOUNT]: 'bank account number',
  [BusinessOnboardingStep.BANK_CONFIRM]: 'bank confirmation',
  [BusinessOnboardingStep.USDC_WALLET]: 'USDC wallet setup',
  [BusinessOnboardingStep.COMPLETE]: 'profile review',
};

export async function ensureBusinessProfile(userId: string) {
  const existing = await db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1);
  if (existing.length > 0) return existing[0];

  const [created] = await db.insert(businesses).values({ userId }).returning();
  await db.insert(businessWallets).values({ businessId: created.id });
  return created;
}

export async function startBusinessOnboarding(ctx: ZendContext, userId: string, resumeStep?: BusinessOnboardingStep) {
  await ensureBusinessProfile(userId);
  const step = resumeStep ?? BusinessOnboardingStep.BUSINESS_NAME;

  await updateBusinessSession(userId, {
    currentFlow: BusinessFlow.ONBOARDING,
    currentStep: step,
    flowData: resumeStep ? undefined : {},
  });

  setSession(userId, { state: ConversationState.IDLE, activeMode: 'business' });

  if (resumeStep) {
    await ctx.reply(`Welcome back! Let's finish setting up your profile. You left off at *${STEP_LABELS[resumeStep]}*.`, {
      parse_mode: 'Markdown',
    });
  } else {
    await ctx.reply(
      `*Welcome to Zend Business!* 🚀\n\n` +
        `The simplest way to invoice clients and get paid — in Naira or crypto.\n\n` +
        `Let's set up your business profile. It takes less than 2 minutes.`,
      { parse_mode: 'Markdown' },
    );
  }

  await promptOnboardingStep(ctx, step);
}

async function promptOnboardingStep(ctx: ZendContext, step: BusinessOnboardingStep) {
  switch (step) {
    case BusinessOnboardingStep.BUSINESS_NAME:
      await ctx.reply('What is your *business name*?', { parse_mode: 'Markdown', ...cancelKeyboard });
      break;
    case BusinessOnboardingStep.BUSINESS_EMAIL:
      await ctx.reply('What is your *business email address*? (This will appear on invoices)', {
        parse_mode: 'Markdown',
        ...cancelKeyboard,
      });
      break;
    case BusinessOnboardingStep.BUSINESS_PHONE:
      await ctx.reply('What is your *business phone number*?', { parse_mode: 'Markdown', ...cancelKeyboard });
      break;
    case BusinessOnboardingStep.BUSINESS_LOGO:
      await ctx.reply(
        'Please upload your business logo. Send it as an image.\n\n_(You can skip this for now and add it later.)_',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('Skip for now', 'biz_onboard_skip_logo')]]),
        },
      );
      break;
    case BusinessOnboardingStep.BANK_NAME: {
      const popular = ['058', '011', '033', '214', '070', '232'];
      const buttons = popular
        .map((code) => NIGERIAN_BANKS.find((b) => b.code === code))
        .filter(Boolean)
        .map((b) => [Markup.button.callback(b!.name, `biz_onboard_bank:${b!.code}`)]);
      buttons.push([Markup.button.callback('Type bank name', 'biz_onboard_bank_type')]);
      await ctx.reply('Which bank do you use?', Markup.inlineKeyboard(buttons));
      break;
    }
    case BusinessOnboardingStep.BANK_ACCOUNT:
      await ctx.reply('Enter your bank account number:', cancelKeyboard);
      break;
    case BusinessOnboardingStep.USDC_WALLET:
      await ctx.reply(
        'Would you like to receive USDC settlements to a crypto wallet as well?\n\n_(Optional — you can always update this later)_',
        Markup.inlineKeyboard([
          [Markup.button.callback('Yes — add wallet', 'biz_onboard_usdc_yes')],
          [Markup.button.callback('Skip for now', 'biz_onboard_usdc_skip')],
        ]),
      );
      break;
    default:
      break;
  }
}

export async function resumeBusinessOnboardingIfNeeded(ctx: ZendContext, userId: string): Promise<boolean> {
  const bizRows = await db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1);
  if (bizRows.length === 0 || bizRows[0].onboardingComplete) return false;

  const { getBusinessSession } = await import('../../services/business/session.js');
  const session = await getBusinessSession(userId);
  const sessionStep = (session?.currentStep as BusinessOnboardingStep) ?? BusinessOnboardingStep.BUSINESS_NAME;
  await startBusinessOnboarding(ctx, userId, sessionStep);
  return true;
}

async function advanceStep(ctx: ZendContext, userId: string, nextStep: BusinessOnboardingStep, flowPatch: Record<string, unknown> = {}) {
  const { getBusinessSession } = await import('../../services/business/session.js');
  const session = await getBusinessSession(userId);
  const flowData = { ...(session?.flowData ?? {}), ...flowPatch };

  await updateBusinessSession(userId, {
    currentFlow: BusinessFlow.ONBOARDING,
    currentStep: nextStep,
    flowData,
  });

  await promptOnboardingStep(ctx, nextStep);
}

export async function handleBusinessOnboardingText(ctx: ZendContext, userId: string, text: string): Promise<boolean> {
  const { getBusinessSession } = await import('../../services/business/session.js');
  const session = await getBusinessSession(userId);
  if (session?.currentFlow !== BusinessFlow.ONBOARDING || !session.currentStep) return false;

  const step = session.currentStep as BusinessOnboardingStep;
  const flow = session.flowData;

  switch (step) {
    case BusinessOnboardingStep.BUSINESS_NAME: {
      if (text.length < 2) {
        await ctx.reply('Please enter a valid business name.');
        return true;
      }
      await db.update(businesses).set({ name: text, updatedAt: new Date() }).where(eq(businesses.userId, userId));
      await advanceStep(ctx, userId, BusinessOnboardingStep.BUSINESS_EMAIL);
      return true;
    }
    case BusinessOnboardingStep.BUSINESS_EMAIL: {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        await ctx.reply('Please enter a valid email address.');
        return true;
      }
      await db.update(businesses).set({ email: text, updatedAt: new Date() }).where(eq(businesses.userId, userId));
      await advanceStep(ctx, userId, BusinessOnboardingStep.BUSINESS_PHONE);
      return true;
    }
    case BusinessOnboardingStep.BUSINESS_PHONE: {
      await db.update(businesses).set({ phone: text, updatedAt: new Date() }).where(eq(businesses.userId, userId));
      await advanceStep(ctx, userId, BusinessOnboardingStep.BUSINESS_LOGO);
      return true;
    }
    case BusinessOnboardingStep.BANK_NAME: {
      const bank = NIGERIAN_BANKS.find(
        (b) => b.name.toLowerCase() === text.toLowerCase() || b.name.toLowerCase().includes(text.toLowerCase()),
      );
      if (!bank) {
        await ctx.reply('Bank not found. Please select from the list or type an exact bank name.');
        return true;
      }
      await advanceStep(ctx, userId, BusinessOnboardingStep.BANK_ACCOUNT, {
        bankCode: bank.code,
        bankName: bank.name,
      });
      await ctx.reply(`Enter your *${bank.name}* account number:`, { parse_mode: 'Markdown', ...cancelKeyboard });
      return true;
    }
    case BusinessOnboardingStep.BANK_ACCOUNT: {
      const accountNumber = text.replace(/\D/g, '');
      if (accountNumber.length < 10) {
        await ctx.reply('Please enter a valid 10-digit account number.');
        return true;
      }

      const bankCode = flow.bankCode as string;
      const bankName = flow.bankName as string;
      let accountName = 'Account Holder';

      const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

      if (user[0]?.pajSessionToken) {
        const verification = await verifyBankAccount(user[0].pajSessionToken, bankCode, accountNumber, userId);
        if (verification.verified && verification.accountName) {
          accountName = verification.accountName;
        }
      }

      await updateBusinessSession(userId, {
        flowData: { ...flow, accountNumber, accountName },
        currentStep: BusinessOnboardingStep.BANK_CONFIRM,
      });

      await ctx.reply(
        `Confirming account details...\n` +
          `Account Name: *${accountName}*\n` +
          `Bank: ${bankName}\n` +
          `Account: \`${accountNumber}\`\n` +
          `Is this correct?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Confirm', 'biz_onboard_bank_confirm')],
            [Markup.button.callback('Re-enter', 'biz_onboard_bank_reenter')],
          ]),
        },
      );
      return true;
    }
    case BusinessOnboardingStep.USDC_WALLET: {
      await db
        .update(businesses)
        .set({ usdcWalletAddress: text, updatedAt: new Date() })
        .where(eq(businesses.userId, userId));
      await completeBusinessOnboarding(ctx, userId);
      return true;
    }
    default:
      return false;
  }
}

export async function completeBusinessOnboarding(ctx: ZendContext, userId: string) {
  const bizRows = await db.select().from(businesses).where(eq(businesses.userId, userId)).limit(1);
  const biz = bizRows[0];
  if (!biz) return;

  await db
    .update(businesses)
    .set({ onboardingComplete: true, updatedAt: new Date() })
    .where(eq(businesses.userId, userId));

  await updateBusinessSession(userId, {
    currentFlow: BusinessFlow.MAIN_MENU,
    currentStep: BusinessOnboardingStep.COMPLETE,
    flowData: {},
  });

  const bankLine = biz.bankName && biz.accountNumber ? `${biz.bankName} — ${biz.accountNumber}` : 'Not set';
  const logoLine = biz.logoUrl ? 'Uploaded ✅' : 'Not uploaded';

  await ctx.reply(
    `*Great! You're all set.* 🎉\n\n` +
      `Here's your business profile:\n` +
      `• Business: ${biz.name}\n` +
      `• Email: ${biz.email}\n` +
      `• Settlement bank: ${bankLine}\n` +
      `• Logo: ${logoLine}\n\n` +
      `You have *3 free invoices* to get started. Let's go!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Generate My First Invoice', 'biz_first_invoice')],
        [Markup.button.callback('Go to Main Menu', 'biz_main_menu')],
      ]),
    },
  );
}

export async function saveBusinessLogo(ctx: ZendContext, userId: string, fileId: string) {
  const { getBusinessSession } = await import('../../services/business/session.js');
  const session = await getBusinessSession(userId);
  if (session?.currentFlow !== BusinessFlow.ONBOARDING || session.currentStep !== BusinessOnboardingStep.BUSINESS_LOGO) {
    return false;
  }

  const fileLink = await ctx.telegram.getFileLink(fileId);
  await db
    .update(businesses)
    .set({ logoUrl: fileLink.toString(), updatedAt: new Date() })
    .where(eq(businesses.userId, userId));

  await ctx.reply('Logo saved! ✅ Now let\'s add your bank account for NGN settlements.');
  await advanceStep(ctx, userId, BusinessOnboardingStep.BANK_NAME);
  return true;
}

export function registerBusinessOnboardingActions({ bot: b }: import('../types.js').HandlerContext): void {
  b.action('biz_onboard_skip_logo', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    await advanceStep(ctx as ZendContext, userId, BusinessOnboardingStep.BANK_NAME);
  });

  b.action(/^biz_onboard_bank:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    const bankCode = ctx.match[1];
    const bank = NIGERIAN_BANKS.find((b) => b.code === bankCode);
    if (!bank) return;

    await advanceStep(ctx as ZendContext, userId, BusinessOnboardingStep.BANK_ACCOUNT, {
      bankCode: bank.code,
      bankName: bank.name,
    });
    await ctx.reply(`Enter your *${bank.name}* account number:`, { parse_mode: 'Markdown', ...cancelKeyboard });
  });

  b.action('biz_onboard_bank_type', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Type your bank name:');
    await ctx.reply('Waiting for your input...', cancelKeyboard);
  });

  b.action('biz_onboard_bank_confirm', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    const { getBusinessSession } = await import('../../services/business/session.js');
    const session = await getBusinessSession(userId);
    const flow = session?.flowData ?? {};

    await db
      .update(businesses)
      .set({
        bankCode: flow.bankCode as string,
        bankName: flow.bankName as string,
        accountNumber: flow.accountNumber as string,
        accountName: flow.accountName as string,
        updatedAt: new Date(),
      })
      .where(eq(businesses.userId, userId));

    await ctx.reply('Bank account saved! ✅');
    await advanceStep(ctx as ZendContext, userId, BusinessOnboardingStep.USDC_WALLET);
  });

  b.action('biz_onboard_bank_reenter', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    await advanceStep(ctx as ZendContext, userId, BusinessOnboardingStep.BANK_ACCOUNT);
  });

  b.action('biz_onboard_usdc_skip', async (ctx) => {
    await ctx.answerCbQuery();
    await completeBusinessOnboarding(ctx as ZendContext, ctx.from!.id.toString());
  });

  b.action('biz_onboard_usdc_yes', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id.toString();
    await updateBusinessSession(userId, { currentStep: BusinessOnboardingStep.USDC_WALLET });
    await ctx.reply('Enter your USDC wallet address:', cancelKeyboard);
  });

  b.action('biz_first_invoice', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('🧾 Invoice generation is coming soon. Stay tuned!');
    await showBusinessMainMenu(ctx as ZendContext, ctx.from!.id.toString());
  });

  b.action('biz_main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await showBusinessMainMenu(ctx as ZendContext, ctx.from!.id.toString());
  });
}