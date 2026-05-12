/**
 * QVAC OCR Service
 * Extracts text from images (screenshots, receipts, payment requests)
 * using QVAC's native ONNX OCR model (OCR_LATIN_RECOGNIZER_1).
 */

import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ocr, getOCRModelId } from './index.js';

const execAsync = promisify(exec);

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

async function convertImageToBmp(inputPath: string): Promise<string> {
  const bmpPath = inputPath.replace(/\.jpg$/, '.bmp');
  await execAsync(
    `ffmpeg -y -i "${inputPath}" -pix_fmt rgb24 "${bmpPath}"`,
    { timeout: 15000 }
  );
  return bmpPath;
}

/**
 * Extract text from an image buffer using QVAC ONNX OCR.
 * Converts image to BMP first (ONNX OCR is picky about formats).
 */
export async function extractTextFromImage(imageBuffer: Buffer): Promise<string> {
  const modelId = await getOCRModelId();
  if (!modelId) {
    throw new Error('QVAC OCR model not loaded. Run initQVAC() first.');
  }

  const jpgPath = await saveTempImage(imageBuffer);
  let bmpPath: string | undefined;

  try {
    bmpPath = await convertImageToBmp(jpgPath);

    const { blocks } = ocr({
      modelId,
      image: bmpPath,
      options: { paragraph: false },
    });

    const result = await blocks;
    const text = result.map((b: { text: string }) => b.text).join('\n');
    return text.trim();
  } catch (err: any) {
    console.error('[QVAC OCR] Failed:', err.message || err);
    throw new Error(`QVAC OCR failed: ${err.message || err}`);
  } finally {
    try { if (jpgPath) await unlink(jpgPath); } catch { /* ignore */ }
    try { if (bmpPath) await unlink(bmpPath); } catch { /* ignore */ }
  }
}

/**
 * Parse a payment receipt/screenshot and extract structured data.
 * Uses OCR + a lightweight regex pass (no extra LLM call needed for speed).
 *
 * IMPORTANT: Extract account number BEFORE amount to avoid confusing
 * 10-digit Nigerian NUBAN codes with amounts.
 */
export async function parseReceiptImage(imageBuffer: Buffer): Promise<ParsedReceipt> {
  const rawText = await extractTextFromImage(imageBuffer);

  // ─── Step 1: Extract account number (10 digits) FIRST ───
  let accountNumber: string | undefined;
  const acctMatch = rawText.match(/\b(\d{10})\b/);
  if (acctMatch) accountNumber = acctMatch[1];

  // ─── Step 2: Extract amount, but EXCLUDE 10-digit account numbers ───
  let amount: number | undefined;
  // Build a "safe" text that masks out account numbers so they can't match as amounts
  let safeText = rawText;
  if (accountNumber) {
    safeText = safeText.replace(new RegExp(`\\b${accountNumber}\\b`, 'g'), '[ACCT]');
  }

  // Amount regex: require some context (currency, comma, decimal, or keywords)
  // Do NOT match bare 10-digit numbers (those are account numbers)
  const amountPatterns = [
    // Currency symbol + number
    /[₦N]\s?(\d[\d,]*(?:\.\d{2})?)\b/i,
    // Number + naira/NGN
    /(\d[\d,]*(?:\.\d{2})?)\s*(?:naira|ngn)/i,
    // Amount/sum/total keyword + number
    /(?:amount|sum|total|₦|N)[\s:]*([\d,]+(?:\.\d{2})?)/i,
    // Number with comma (Nigerian style: 50,000) — at least one comma
    /(\d{1,3}(?:,\d{3})+(?:\.\d{2})?)\b/,
    // Number with decimal (e.g., 1500.00) — must have decimal
    /(\d+\.\d{2})\b/,
  ];

  for (const pattern of amountPatterns) {
    const match = safeText.match(pattern);
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      // Sanity check: amounts on receipts are typically < 10,000,000 and > 100
      if (val > 100 && val < 10000000 && !Number.isNaN(val)) {
        amount = val;
        break;
      }
    }
  }

  // ─── Step 3: Extract bank name ───
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

  // ─── Step 4: Extract recipient name ───
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
