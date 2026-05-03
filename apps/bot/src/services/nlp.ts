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
  // Check 'k' format FIRST (e.g., 50k, 100k)
  /(?:send|transfer|pay)\s+(?:me\s+)?[₦N]?(\d+k)\b/i,
  /[₦N]?(\d+k)\b/i,
  // Then check regular numbers
  /(?:send|transfer|pay)\s+(?:me\s+)?[₦N]?(\d[\d,]*(?:\.\d+)?)\s*(?:naira|ngn)?/i,
  /[₦N]?(\d[\d,]*(?:\.\d+)?)\s*(?:naira|ngn)/i,
];

// ─── Bank Detection ───
// Build patterns dynamically from NIGERIAN_BANKS + common aliases

const BANK_ALIASES: Record<string, string[]> = {
  'GTB': ['gtb', 'gtbank', 'guaranty trust bank', 'guaranty trust', 'gt bank'],
  'FBN': ['first bank', 'fbn', 'firstbank', 'first'],
  'UBA': ['uba', 'united bank for africa'],
  'ZEN': ['zenith', 'zenith bank'],
  'ACC': ['access', 'access bank'],
  'ECO': ['ecobank', 'eco bank'],
  'FID': ['fidelity', 'fidelity bank'],
  'FCMB': ['fcmb', 'first city monument', 'first city'],
  'WEM': ['wema', 'wema bank'],
  'SKY': ['polaris', 'polaris bank', 'skye', 'skye bank'],
  'STERLING': ['sterling', 'sterling bank'],
  'UNITY': ['unity', 'unity bank'],
  'JAB': ['jaiz', 'jaiz bank'],
  'KEC': ['keystone', 'keystone bank'],
  'HERITAGE': ['heritage', 'heritage bank'],
  'STA': ['stanbic', 'stanbic ibtc', 'stanbic bank'],
  'UNI': ['union', 'union bank'],
  'TIT': ['titan', 'titan trust', 'titan trust bank'],
  'GLO': ['globus', 'globus bank'],
  'PRO': ['providus', 'providus bank'],
  'SUN': ['suntrust', 'suntrust bank', 'sun trust'],
  'PAR': ['parallex', 'parallex bank'],
  'COR': ['coronation', 'coronation merchant bank'],
  'FSD': ['fsdh', 'fsdh merchant bank'],
  'RAN': ['rand', 'rand merchant bank'],
  'NOV': ['nova', 'nova merchant bank'],
  // Fintechs / MMOs
  'OPY': ['opay', 'o pay'],
  'MON': ['moniepoint', 'monie point'],
  'KUD': ['kuda', 'kuda bank'],
  'PAL': ['palmpay', 'palm pay'],
  'PAG': ['paga', 'paga bank'],
  'VFD': ['vfd', 'vfd microfinance', 'vfd bank'],
  'CAR': ['carbon', 'carbon bank'],
  'FAI': ['fairmoney', 'fair money'],
  'BRA': ['branch', 'branch bank'],
};

// Build regex patterns from aliases
const BANK_PATTERNS = Object.entries(BANK_ALIASES).flatMap(([code, names]) =>
  names.map(name => ({
    code,
    name,
    // Use word boundary OR space/punctuation before/after
    regex: new RegExp(`(?:^|[\\s,;:-])${name}(?:[\\s,;:-]|$)`, 'i'),
  }))
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
  const lowerText = text.toLowerCase();

  // Try strict regex patterns first
  for (const bank of BANK_PATTERNS) {
    if (bank.regex.test(text)) {
      // Return canonical name from NIGERIAN_BANKS
      const canonical = NIGERIAN_BANKS.find(b => b.code === bank.code);
      return { code: bank.code, name: canonical?.name || bank.name };
    }
  }

  // Fallback: simple includes check for aliases
  for (const [code, aliases] of Object.entries(BANK_ALIASES)) {
    for (const alias of aliases) {
      if (lowerText.includes(alias.toLowerCase())) {
        const canonical = NIGERIAN_BANKS.find(b => b.code === code);
        return { code, name: canonical?.name || alias };
      }
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
  const lowerText = text.toLowerCase();
  let anchorIndex = -1;

  // Try to find position of bank name (full match first)
  if (bankName) {
    // Find the bank name in text, but check all aliases to find earliest match
    const bankEntry = Object.entries(BANK_ALIASES).find(([code, aliases]) => {
      const canonical = NIGERIAN_BANKS.find(b => b.code === code);
      return canonical?.name === bankName || aliases.includes(bankName.toLowerCase());
    });

    if (bankEntry) {
      for (const alias of bankEntry[1]) {
        const idx = lowerText.indexOf(alias);
        if (idx !== -1 && (anchorIndex === -1 || idx < anchorIndex)) {
          anchorIndex = idx;
        }
      }
    }

    // Fallback to direct bank name match
    if (anchorIndex === -1) {
      anchorIndex = lowerText.indexOf(bankName.toLowerCase());
    }
    if (anchorIndex === -1) {
      anchorIndex = lowerText.indexOf(bankName.toLowerCase().split(' ')[0]);
    }
  }

  // Fallback: find position of account number
  if (anchorIndex === -1 && accountNumber) {
    anchorIndex = lowerText.indexOf(accountNumber);
  }

  if (anchorIndex > 0) {
    const beforeAnchor = text.slice(0, anchorIndex).trim();
    // Remove common prepositions at the end
    const cleaned = beforeAnchor.replace(/\s+(to|for|at|into|towards)$/i, '').trim();
    const words = cleaned.split(/\s+/);

    // Look for capitalized name words at the end
    const nameWords: string[] = [];
    for (let i = words.length - 1; i >= 0; i--) {
      const word = words[i].replace(/[^a-zA-Z]/g, '');
      if (/^[A-Z][a-z]+$/.test(word) && !['Send', 'Transfer', 'Pay', 'Give'].includes(word)) {
        nameWords.unshift(word);
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

if (!KIMI_API_KEY || KIMI_API_KEY === 'your_openai_key') {
  console.warn('[NLP] ⚠️  KIMI_API_KEY not set — AI features disabled');
}

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
      const errText = await response.text().catch(() => '');
      console.error(`[NLP] Kimi API error ${response.status}: ${errText.slice(0, 200)}`);
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

// ─── Conversational AI (Smart Assistant) ───

const CHAT_SYSTEM_PROMPT = `You are Zend, a friendly and helpful Nigerian crypto payment assistant running inside a Telegram bot.

Your personality: Warm, concise, slightly witty, and always helpful. You speak like a knowledgeable Nigerian friend. Use simple English. Occasionally use light Nigerian Pidgin phrases like "No wahala" or "Sharp sharp" when it feels natural.

What Zend can do:
• 💰 Check wallet balance (SOL, USDT, USDC) — just say "balance" or tap 💰 Balance
• 💵 Add Naira — deposit NGN via bank transfer to a virtual account, get USDT in your wallet
• 📤 Send to any Nigerian bank account — just say "Send 50k to Tunde GTB 0123456789"
• 📥 Receive crypto — share your Solana wallet address or virtual account
• 🔄 Swap tokens — exchange SOL/USDT/USDC inside your wallet
• 📋 View transaction history
• 🎙️ Voice messages — send a voice note saying what you want to do

Important rules:
- Keep replies under 150 words (Telegram messages should be punchy).
- If the user asks something you can't do, suggest the closest alternative.
- If they ask about fees: 1% Zend fee + Solana gas (~0.001 SOL).
- If they ask about security: wallets are encrypted, PAJ handles KYC.
- If they greet you, greet back warmly and offer to help.
- If they ask "what can you do", give a friendly summary of features.
- If they ask "how do I send money", give a quick step-by-step.
- Never make up features that don't exist (no airtime, no loans, no betting).
- Always end by nudging them to try something: "Wanna check your balance?" or "Ready to send some money?"`;

export interface ChatReply {
  reply: string;
  suggestedAction?: string;
}

/**
 * Get a conversational reply from Kimi when the user's message is not a command.
 */
export async function chatWithKimi(text: string): Promise<ChatReply | null> {
  if (!KIMI_API_KEY || KIMI_API_KEY === 'your_openai_key') {
    return null;
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
          { role: 'system', content: CHAT_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        temperature: 0.7,
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[Chat] Kimi API error ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data: any = await response.json();
    const reply = data.choices[0]?.message?.content?.trim();
    
    if (!reply) return null;

    return { reply };
  } catch (err) {
    console.error('[Chat] Kimi chat failed:', err);
    return null;
  }
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
