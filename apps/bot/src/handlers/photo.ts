import { Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { db, users } from '@zend/db';
import { eq } from 'drizzle-orm';
import { parseReceiptWithQVAC } from '../services/nlp.js';
import { ConversationState, NIGERIAN_BANKS } from '@zend/shared';
import { mainMenu } from '../keyboards/index.js';
import { showLoading, finishLoading } from '../lib/loading.js';
import { getSession, setSession } from '../session/store.js';
import type { HandlerContext } from './types.js';

export function registerPhotoHandlers({ bot: b }: HandlerContext): void {
  b.on(message('photo'), async (ctx) => {
  const userId = ctx.from.id.toString();
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  if (user.length === 0) {
    await ctx.reply('Please run /start first.', mainMenu);
    return;
  }

  const loading = await showLoading(ctx, 'Reading your screenshot with QVAC OCR...');
  const startTime = Date.now();

  try {
    // Get the largest photo
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    console.log(`[Photo] Downloading image ${photo.file_id} (${photo.width}x${photo.height})`);
    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const response = await fetch(fileLink.toString());
    const imageBuffer = Buffer.from(await response.arrayBuffer());
    console.log(`[Photo] Downloaded ${imageBuffer.length} bytes in ${Date.now() - startTime}ms`);

    const receipt = await parseReceiptWithQVAC(imageBuffer);
    console.log(`[Photo] Parsed receipt in ${Date.now() - startTime}ms:`, receipt);

    if (!receipt || !receipt.rawText) {
      await finishLoading(ctx, loading.message_id, '❌ Could not read text from this image. Try a clearer screenshot.');
      await ctx.reply('Menu:', mainMenu);
      return;
    }

    // Guard: if amount equals account number, LLM/parser confused them
    if (receipt.amount && receipt.accountNumber && receipt.amount.toString() === receipt.accountNumber) {
      receipt.amount = undefined;
    }

    // If we got structured data, offer to send
    if (receipt.amount && receipt.accountNumber && receipt.bankName) {
      await finishLoading(ctx, loading.message_id, `📝 I found payment details!\n\nAmount: ₦${receipt.amount.toLocaleString()}\nBank: ${receipt.bankName}\nAccount: ${receipt.accountNumber}\nName: ${receipt.recipientName || 'Unknown'}`, 'Markdown');

      // Find bank code
      const bank = NIGERIAN_BANKS.find(b =>
        b.name.toLowerCase().includes((receipt.bankName || '').toLowerCase()) ||
        (receipt.bankName || '').toLowerCase().includes(b.name.toLowerCase())
      );

      if (bank) {
        setSession(userId, {
          state: ConversationState.AWAITING_CONFIRMATION,
          pendingTransaction: {
            amountNgn: receipt.amount,
            recipientAccountNumber: receipt.accountNumber,
            recipientBankCode: bank.code,
            recipientBankName: bank.name,
            recipientName: receipt.recipientName || 'Recipient',
          },
        });

        await ctx.reply(
          `Send ₦${receipt.amount.toLocaleString()} to ${receipt.recipientName || 'Recipient'} at ${bank.name}?`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Confirm', 'confirm_send')],
            [Markup.button.callback('❌ Cancel', 'cancel_send')],
          ])
        );
        return;
      }
    }

    // Partial parse — show what we found
    const found: string[] = [];
    if (receipt.amount) found.push(`Amount: ₦${receipt.amount.toLocaleString()}`);
    if (receipt.bankName) found.push(`Bank: ${receipt.bankName}`);
    if (receipt.accountNumber) found.push(`Account: ${receipt.accountNumber}`);
    if (receipt.recipientName) found.push(`Name: ${receipt.recipientName}`);

    if (found.length > 0) {
      await finishLoading(ctx, loading.message_id, `📝 I found some details:\n\n${found.join('\n')}\n\nBut I'm missing some info to send money.`, 'Markdown');
    } else {
      await finishLoading(ctx, loading.message_id, `📝 I can see text in the image, but couldn't find payment details.\n\nTry sending a clearer screenshot of the bank app or payment request.`);
    }

    await ctx.reply('Menu:', mainMenu);
  } catch (err: any) {
    console.error('[OCR] Error:', err.message || err);
    try {
      await finishLoading(ctx, loading.message_id, '❌ Could not process image. Please try again or type the details manually.');
    } catch {
      await ctx.reply('❌ Could not process image. Please try again or type the details manually.', mainMenu);
    }
    await ctx.reply('Menu:', mainMenu);
  }
});
}
