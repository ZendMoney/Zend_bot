/**
 * QVAC OCR Service
 * Extracts text from images (screenshots, receipts, payment requests)
 * using QVAC's native ONNX OCR model (OCR_LATIN_RECOGNIZER_1).
 */

import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ocr, getOCRModelId } from './index.js';

export interface ParsedReceipt {
  amount?: number;
  bankName?: string;
  accountNumber?: string;
  recipientName?: string;
  rawText: string;
}

async function saveTempImage(buffer: Buffer): Promise<string> {
  const path = join(tmpdir(), `qvac_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  await writeFile(path, buffer);
  return path;
}

/**
 * Extract text from an image buffer using QVAC ONNX OCR.
 */
export async function extractTextFromImage(imageBuffer: Buffer): Promise<string> {
  const modelId = await getOCRModelId();
  if (!modelId) {
    throw new Error('QVAC OCR model not loaded. Run initQVAC() first.');
  }

  const tempPath = await saveTempImage(imageBuffer);

  try {
    const { blocks } = ocr({
      modelId,
      image: tempPath,
      options: { paragraph: false },
    });

    const result = await blocks;
    const text = result.map((b: { text: string }) => b.text).join('\n');
    return text.trim();
  } catch (err: any) {
    console.error('[QVAC OCR] Failed:', err.message || err);
    throw new Error(`QVAC OCR failed: ${err.message || err}`);
  } finally {
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
