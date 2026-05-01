/**
 * NLP Service for Zend Bot
 * Parses natural language commands for Nigerian crypto payments
 * Uses local regex patterns + Kimi (Moonshot) API for complex cases
 */

import { NIGERIAN_BANKS } from '@zend/shared';

// ─── Types ───

export interface ParsedCommand {
  intent: 'send' | 'add_naira' | 'cash_out' | 'balance' | 'unknown';
  amount?: number;
  currency?: 'NGN' | 'USDT' | 'SOL';
  recipientName?: string;
  bankName?: string;
  bankCode?: string;
  accountNumber?: string;
  walletAddress?: string;
  raw: string;
}

// ─── Local Parser (fast, no API cost) ───

const AMOUNT_PATTERNS = [
  /(?:send|transfer|pay)\s+(?:me\s+)?[₦N]?(\d[\d,]*(?:\.\d+)?)\s*(?:naira|ngn)?/i,
  /(?:send|transfer|pay)\s+(?:me\s+)?(\d+k)\b/i,
  /[₦N]?(\d[\d,]*(?:\.\d+)?)\s*(?:naira|ngn)/i,
  /(\d+k)\b/i,
];

const BANK_PATTERNS = Object.entries({
  'GTB': ['gtb', 'gtbank', 'guaranty trust bank', 'guaranty trust'],
  'FIRST': ['first bank', 'fbn', 'firstbank'],
  'UBA': ['uba', 'united bank for africa'],
  'ZENITH': ['zenith', 'zenith bank'],
  'ACCESS': ['access', 'access bank'],
  'ECOBANK': ['ecobank'],
  'FIDELITY': ['fidelity', 'fidelity bank'],
  'FCMB': ['fcmb', 'first city monument'],
  'WEMA': ['wema', 'wema bank'],
  'POLARIS': ['polaris', 'polaris bank', 'skye'],
  'STERLING': ['sterling', 'sterling bank'],
  'UNITY': ['unity', 'unity bank'],
  'JAIZ': ['jaiz', 'jaiz bank'],
  'KEYSTONE': ['keystone', 'keystone bank'],
  'HERITAGE': ['heritage', 'heritage bank'],
  'STANBIC': ['stanbic', 'stanbic ibtc'],
  'UNION': ['union', 'union bank'],
  'GTCO': ['gtco'],
}).flatMap(([code, names]) =>
  names.map(name => ({ code, name, regex: new RegExp(`\\b${name}\\b`, 'i') }))
);

const ACCOUNT_NUMBER_PATTERN = /\b(\d{10})\b/;
const WALLET_ADDRESS_PATTERN = /\b([A-Za-z0-9]{32,44})\b/;

function parseAmountK(match: string): number {
  const num = parseFloat(match.replace(/,/g, ''));
  if (match.toLowerCase().endsWith('k')) {
    return num * 1000;
  }
  return num;
}

function extractAmount(text: string): number | undefined {
  for (const pattern of AMOUNT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const amountStr = match[1];
      if (amountStr.toLowerCase().endsWith('k')) {
        return parseFloat(amountStr) * 1000;
      }
      return parseFloat(amountStr.replace(/,/g, ''));
    }
  }
  return undefined;
}

function extractBank(text: string): { code: string; name: string } | undefined {
  for (const bank of BANK_PATTERNS) {
    if (bank.regex.test(text)) {
      return { code: bank.code, name: bank.name };
    }
  }
  return undefined;
}

function extractAccountNumber(text: string): string | undefined {
  const match = text.match(ACCOUNT_NUMBER_PATTERN);
  return match ? match[1] : undefined;
}

function extractWalletAddress(text: string): string | undefined {
  const match = text.match(WALLET_ADDRESS_PATTERN);
  return match ? match[1] : undefined;
}

function extractRecipientName(text: string, bankName?: string, accountNumber?: string): string | undefined {
  // Simple heuristic: look for a capitalized word before the bank name
  const lowerText = text.toLowerCase();
  const bankIndex = bankName ? lowerText.indexOf(bankName.toLowerCase().split(' ')[0]) : -1;
  
  if (bankIndex > 0) {
    const beforeBank = text.slice(0, bankIndex).trim();
    const words = beforeBank.split(/\s+/);
    // Look for a name pattern (capitalized word(s))
    const nameWords: string[] = [];
    for (let i = words.length - 1; i >= 0; i--) {
      if (/^[A-Z][a-z]+$/.test(words[i])) {
        nameWords.unshift(words[i]);
      } else if (nameWords.length > 0) {
        break;
      }
    }
    if (nameWords.length > 0) {
      return nameWords.join(' ');
    }
  }
  
  return undefined;
}

function detectIntent(text: string): ParsedCommand['intent'] {
  const lower = text.toLowerCase();
  
  if (/\b(send|transfer|pay)\b/.test(lower) && extractAccountNumber(text)) {
    return 'send';
  }
  if (/\b(send|transfer|pay)\b/.test(lower) && extractWalletAddress(text)) {
    return 'send';
  }
  if (/\b(add|deposit|fund)\b.*\b(naira|ngn|money)\b/.test(lower)) {
    return 'add_naira';
  }
  if (/\b(cash out|withdraw|off.?ramp)\b/.test(lower)) {
    return 'cash_out';
  }
  if (/\b(balance|how much|what.*have)\b/.test(lower)) {
    return 'balance';
  }
  
  return 'unknown';
}

/**
 * Parse natural language command locally (fast, no API call)
 */
export function parseLocal(text: string): ParsedCommand {
  const intent = detectIntent(text);
  const amount = extractAmount(text);
  const bank = extractBank(text);
  const accountNumber = extractAccountNumber(text);
  const walletAddress = extractWalletAddress(text);
  const recipientName = extractRecipientName(text, bank?.name, accountNumber);

  return {
    intent,
    amount,
    currency: amount ? 'NGN' : undefined,
    recipientName,
    bankName: bank?.name,
    bankCode: bank?.code,
    accountNumber,
    walletAddress,
    raw: text,
  };
}

// ─── Kimi (Moonshot) API Parser ───

const KIMI_API_KEY = process.env.KIMI_API_KEY || process.env.OPENAI_API_KEY;
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1';

const SYSTEM_PROMPT = `You are a payment command parser for a Nigerian crypto wallet bot.
Extract the following from user messages:
- intent: "send" | "add_naira" | "cash_out" | "balance" | "unknown"
- amount: number (always in NGN, convert "50k" to 50000)
- recipientName: person or business name
- bankName: full bank name
- bankCode: one of: GTB, FIRST, UBA, ZENITH, ACCESS, ECOBANK, FIDELITY, FCMB, WEMA, POLARIS, STERLING, UNITY, JAIZ, KEYSTONE, HERITAGE, STANBIC, UNION
- accountNumber: 10 digit Nigerian bank account number
- walletAddress: Solana wallet address (32-44 chars)

Respond ONLY with valid JSON. No markdown, no explanation.`;

/**
 * Parse using Kimi API (for complex/voice transcribed text)
 */
export async function parseWithKimi(text: string): Promise<ParsedCommand> {
  if (!KIMI_API_KEY || KIMI_API_KEY === 'your_openai_key') {
    console.log('[NLP] No Kimi API key, falling back to local parser');
    return parseLocal(text);
  }

  try {
    const response = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KIMI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'moonshot-v1-8k',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      throw new Error(`Kimi API error: ${response.status}`);
    }

    const data: any = await response.json();
    const content = data.choices[0]?.message?.content || '{}';
    
    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    return {
      intent: parsed.intent || 'unknown',
      amount: parsed.amount ? Number(parsed.amount) : undefined,
      currency: parsed.currency || 'NGN',
      recipientName: parsed.recipientName,
      bankName: parsed.bankName,
      bankCode: parsed.bankCode,
      accountNumber: parsed.accountNumber?.toString(),
      walletAddress: parsed.walletAddress,
      raw: text,
    };
  } catch (err) {
    console.error('[NLP] Kimi parse failed:', err);
    return parseLocal(text);
  }
}

/**
 * Main parse function - tries local first, falls back to Kimi
 */
export async function parseCommand(text: string, useKimi = false): Promise<ParsedCommand> {
  // For voice or complex text, use Kimi
  if (useKimi) {
    return parseWithKimi(text);
  }
  
  // Try local first
  const local = parseLocal(text);
  
  // If local couldn't parse well, try Kimi
  if (local.intent === 'unknown' && KIMI_API_KEY && KIMI_API_KEY !== 'your_openai_key') {
    return parseWithKimi(text);
  }
  
  return local;
}

// ─── Voice Transcription ───

/**
 * Transcribe audio using Kimi's audio API or OpenAI Whisper
 * Note: Kimi doesn't have native STT yet, so we use OpenAI Whisper
 */
export async function transcribeVoice(audioBuffer: Buffer, apiKey?: string): Promise<string> {
  const key = apiKey || process.env.OPENAI_API_KEY;
  
  if (!key || key === 'your_openai_key') {
    throw new Error('No API key for voice transcription. Set OPENAI_API_KEY in .env');
  }

  try {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
    formData.append('file', blob, 'voice.ogg');
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Transcription error: ${response.status}`);
    }

    const data: any = await response.json();
    return data.text || '';
  } catch (err) {
    console.error('[NLP] Voice transcription failed:', err);
    throw err;
  }
}
