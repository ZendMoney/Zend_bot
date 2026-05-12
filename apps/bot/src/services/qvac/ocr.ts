/**
 * QVAC OCR Service
 * Extracts text from images using the multimodal LLM (completion + attachments).
 * The OCR model is a llamacpp-completion model, not onnx-ocr, so we use
 * completion() with image attachments instead of the ocr() SDK call.
 */

import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { completion, getOCRModelId } from './index.js';

export interface ParsedReceipt {
  amount?: number;
  bankName?: string;
  accountNumber?: string;
  recipientName?: string;
  rawText: string;
}

/**
 * Save buffer to a temp file and return the path.
 */
async function bufferToTempFile(buffer: Buffer, ext = 'png'): Promise<string> {
  const tempPath = join(tmpdir(), `qvac_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  await writeFile(tempPath, buffer);
  return tempPath;
}

/**
 * Extract text from an image buffer using the multimodal completion model.
 */
export async function extractTextFromImage(imageBuffer: Buffer): Promise<string> {
  const modelId = await getOCRModelId();
  if (!modelId) {
    throw new Error('QVAC OCR model not loaded. Run initQVAC() first.');
  }

  const tempPath = await bufferToTempFile(imageBuffer, 'jpg');

  try {
    const run = completion({
      modelId,
      history: [
        {
          role: 'system',
          content: 'You are an OCR engine. Extract all visible text from the attached image. Return ONLY the raw text. Do not add explanations, summaries, or markdown formatting.',
        },
        {
          role: 'user',
          content: 'Extract all text from this image:',
          attachments: [{ path: tempPath }],
        },
      ],
      stream: false,
      generationParams: {
        temp: 0.1,
        predict: 1024,
        top_p: 0.9,
        top_k: 40,
      },
    });

    const result = await run.final;
    const text = result.contentText || result.raw?.fullText || '';
    return text.trim();
  } catch (err: any) {
    console.error('[QVAC OCR] Failed:', err.message || err);
    throw new Error(`QVAC OCR failed: ${err.message || err}`);
  } finally {
    // Clean up temp file (best effort)
    try { await unlink(tempPath); } catch { /* ignore */ }
  }
}

/**
 * Parse a payment receipt/screenshot and extract structured data.
 * Uses OCR + a lightweight regex pass (no extra LLM call needed for speed).
 */
export async function parseReceiptImage(imageBuffer: Buffer): Promise<ParsedReceipt> {
  const rawText = await extractTextFromImage(imageBuffer);

  // Try to extract amount
  let amount: number | undefined;
  const amountMatch = rawText.match(/[₦N]?(\d[\d,]*(?:\.\d+)?)\s*(?:naira|ngn)?/i) ||
                      rawText.match(/(?:amount|sum|total)[:\s]*[₦N]?(\d[\d,]*(?:\.\d+)?)/i);
  if (amountMatch) {
    amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  }

  // Try to extract account number (10 digits)
  let accountNumber: string | undefined;
  const acctMatch = rawText.match(/\b(\d{10})\b/);
  if (acctMatch) accountNumber = acctMatch[1];

  // Try to extract bank name
  let bankName: string | undefined;
  const bankKeywords = [
    'GTBank', 'Guaranty Trust Bank',
    'First Bank', 'FirstBank',
    'UBA', 'United Bank for Africa',
    'Zenith Bank', 'Zenith',
    'Access Bank', 'Access',
    'Ecobank', 'Eco Bank',
    'Fidelity Bank', 'Fidelity',
    'FCMB',
    'Wema Bank', 'Wema',
    'Polaris Bank', 'Polaris', 'Skye Bank',
    'Sterling Bank', 'Sterling',
    'Stanbic IBTC', 'Stanbic',
    'Union Bank', 'Union',
    'Keystone Bank', 'Keystone',
    'Heritage Bank', 'Heritage',
    'Jaiz Bank', 'Jaiz',
    'OPay',
    'Kuda',
    'PalmPay',
    'Moniepoint',
    'Paga',
    'VFD',
    'Carbon',
    'FairMoney',
    'Branch',
  ];
  for (const bank of bankKeywords) {
    if (rawText.toLowerCase().includes(bank.toLowerCase())) {
      bankName = bank;
      break;
    }
  }

  // Try to extract recipient name (heuristic: name near account number)
  let recipientName: string | undefined;
  const nameMatch = rawText.match(/(?:name|recipient|to|beneficiary)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/i);
  if (nameMatch) recipientName = nameMatch[1].trim();

  return {
    amount,
    bankName,
    accountNumber,
    recipientName,
    rawText,
  };
}
