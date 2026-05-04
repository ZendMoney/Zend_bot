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
  fromToken?: 'USDT' | 'USDC' | 'SOL';
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
    regex: new RegExp(`(?:^|[\\s,;:.!?-])${name}(?:[\\s,;:.!?-]|$)`, 'i'),
  }))
);

const ACCOUNT_NUMBER_PATTERN = /\b(\d[\d\s\-\.]{8,18}\d)\b/;

// Strip non-digits from account numbers (Whisper adds dashes, spaces, dots)
function sanitizeAccountNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  // NUBAN is 10 digits, but allow 10-20 for safety (some users include country codes)
  return digits.length >= 10 ? digits : null;
}
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
  return match ? sanitizeAccountNumber(match[1]) || undefined : undefined;
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

function extractFromToken(text: string): ParsedCommand['fromToken'] {
  const lower = text.toLowerCase();
  if (/\b(from\s+usdc|using\s+usdc|with\s+usdc|usdc\s+bal|my\s+usdc)\b/.test(lower)) return 'USDC';
  if (/\b(from\s+sol|using\s+sol|with\s+sol|sol\s+bal|my\s+sol)\b/.test(lower)) return 'SOL';
  if (/\b(from\s+usdt|using\s+usdt|with\s+usdt|usdt\s+bal|my\s+usdt)\b/.test(lower)) return 'USDT';
  // Generic mention of USDC without "from"
  if (/\busdc\b/.test(lower) && !/\busdt\b/.test(lower)) return 'USDC';
  return undefined;
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
  const fromToken = extractFromToken(text);

  return {
    intent,
    amount,
    currency: amount ? 'NGN' : undefined,
    fromToken,
    recipientName,
    bankName: bank?.name,
    bankCode: bank?.code,
    accountNumber,
    walletAddress,
    raw: text,
  };
}

// ─── Kimi Coding API (same pattern as snipey_v2) ───

const KIMI_API_KEY = process.env.KIMI_API_KEY || process.env.OPENAI_API_KEY;
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-for-coding';

// Normalize base URL — strip trailing /v1 if present so we don't get /v1/v1/messages
function getKimiBaseUrl(): string {
  let url = KIMI_BASE_URL;
  if (url.endsWith('/v1')) {
    url = url.slice(0, -3);
  }
  return url.replace(/\/$/, '');
}

if (!KIMI_API_KEY || KIMI_API_KEY === 'your_openai_key') {
  console.warn('[NLP] ⚠️  KIMI_API_KEY not set — AI features disabled');
}

function getKimiResponse(data: any): string {
  // Anthropic-style response: content[0].text
  const text = data?.content?.[0]?.text;
  if (text) return text;
  // Fallback to OpenAI-style
  return data?.choices?.[0]?.message?.content || '';
}

async function callKimi(systemPrompt: string, userPrompt: string, temperature: number, maxTokens: number): Promise<string | null> {
  if (!KIMI_API_KEY || KIMI_API_KEY === 'your_openai_key') {
    return null;
  }

  try {
    const response = await fetch(`${getKimiBaseUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KIMI_API_KEY}`,
        'User-Agent': 'claude-code/0.1.0',
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[Kimi] API error ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data: any = await response.json();
    return getKimiResponse(data) || null;
  } catch (err) {
    console.error('[Kimi] API call failed:', err);
    return null;
  }
}

// ─── Command Parser ───

const SYSTEM_PROMPT = `You are a payment command parser for a Nigerian crypto wallet bot.
Extract the following from user messages:
- intent: "send" | "add_naira" | "cash_out" | "balance" | "unknown"
- amount: number (always in NGN, convert "50k" to 50000)
- recipientName: person or business name
- bankName: full bank name
- bankCode: one of: GTB, FIRST, UBA, ZENITH, ACCESS, ECOBANK, FIDELITY, FCMB, WEMA, POLARIS, STERLING, UNITY, JAIZ, KEYSTONE, HERITAGE, STANBIC, UNION, OPY, KUD, PAL, MON, PAG, VFD, CAR, FAI, BRA
- accountNumber: 10 digit Nigerian bank account number
- walletAddress: Solana wallet address (32-44 chars)
- fromToken: "USDT" | "USDC" | "SOL" — the crypto token user wants to send FROM. Default USDT unless they mention USDC or SOL.

Respond ONLY with valid JSON. No markdown, no explanation.`;

/**
 * Parse using Kimi API (for complex/voice transcribed text)
 */
export async function parseWithKimi(text: string): Promise<ParsedCommand> {
  const content = await callKimi(SYSTEM_PROMPT, text, 0.1, 500);
  if (!content) {
    console.log('[NLP] No Kimi API key or call failed, falling back to local parser');
    return parseLocal(text);
  }

  try {
    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    return {
      intent: parsed.intent || 'unknown',
      amount: parsed.amount ? Number(parsed.amount) : undefined,
      currency: parsed.currency || 'NGN',
      fromToken: parsed.fromToken || extractFromToken(text),
      recipientName: parsed.recipientName,
      bankName: parsed.bankName,
      bankCode: parsed.bankCode,
      accountNumber: sanitizeAccountNumber(parsed.accountNumber) || undefined,
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
  if (useKimi) {
    return parseWithKimi(text);
  }
  
  const local = parseLocal(text);
  
  if (local.intent === 'unknown' && KIMI_API_KEY && KIMI_API_KEY !== 'your_openai_key') {
    return parseWithKimi(text);
  }
  
  return local;
}

// ─── Conversational AI (Smart Assistant) ───

const CHAT_SYSTEM_PROMPT = `You are Zend, a friendly Nigerian crypto payment assistant inside a Telegram bot.

Your personality: Warm, concise, helpful. Speak like a knowledgeable Nigerian friend. Light Pidgin like "No wahala" or "Sharp sharp" is fine when natural.

EXACT features Zend has (do NOT mention anything else):
1. Check wallet balance — SOL, USDT, USDC with live Naira rates
2. Add Naira — bank transfer to a virtual account, get USDT in wallet
3. Send to Nigerian bank — any bank (GTB, UBA, Access, OPay, Kuda, etc.)
4. Receive crypto — Solana wallet address + virtual account
5. Swap tokens — SOL ↔ USDT ↔ USDC
6. Transaction history
7. Voice commands — send a voice note

EXACT features Zend does NOT have (never mention these):
- NO airtime recharge
- NO data bundles
- NO bill payments (electricity, cable, etc.)
- NO loans or borrowing
- NO betting or gambling
- NO stocks or investment trading
- NO cross-chain to Ethereum/Bitcoin

If asked about fees: 1% Zend fee + Solana network gas (~0.001 SOL).
If asked about security: wallets are encrypted, PAJ handles KYC compliance.
Keep replies under 150 words. End with a nudge to try something real.`;

export interface ChatReply {
  reply: string;
  suggestedAction?: string;
}

/**
 * Get a conversational reply from Kimi when the user's message is not a command.
 */
export async function chatWithKimi(text: string): Promise<ChatReply | null> {
  const reply = await callKimi(CHAT_SYSTEM_PROMPT, text, 0.7, 400);
  if (!reply) return null;
  return { reply: reply.trim() };
}

// ─── Voice Transcription (Local whisper.cpp — same as OpenClaw) ───

import { transcribeWithWhisper } from './whisper/index.js';

export async function transcribeVoice(audioBuffer: Buffer): Promise<string> {
  return transcribeWithWhisper(audioBuffer);
}

// ─── Voice Confirmation AI ───

const VOICE_CONFIRM_PROMPT = `You are Zend, a Nigerian crypto payment assistant. A user sent a voice note.

Your job:
1. Understand what they want to do
2. Extract relevant details
3. Respond in a friendly, conversational way

Supported intents:
- "balance" — check wallet balance
- "add_naira" — deposit NGN (extract amount if mentioned)
- "send" — send money to bank (extract amount, recipient name, bank, account number)
- "cash_out" — withdraw to bank (same as send)
- "receive" — show how to receive money
- "history" — show transaction history
- "swap" — swap tokens
- "settings" — open settings
- "chat" — general conversation

Response format — JSON only:
{
  "intent": "balance" | "add_naira" | "send" | "cash_out" | "receive" | "history" | "swap" | "settings" | "chat",
  "amount": number | null,
  "recipientName": string | null,
  "bankName": string | null,
  "bankCode": string | null,
  "accountNumber": string | null,
  "walletAddress": string | null,
  "message": "Your friendly response to the user.",
  "needsConfirm": true | false
}

Rules:
- "needsConfirm": true ONLY for send/cash_out with BOTH amount AND (accountNumber OR walletAddress)
- "message" should be warm and conversational, in Nigerian style
- If send/cash_out missing details, set needsConfirm:false and ask what's missing
- For balance/receive/history/swap/settings: set needsConfirm:false, just acknowledge
- Never make up details. If unsure, ask.`;

export interface VoiceAnalysis {
  intent: string;
  amount: number | null;
  recipientName: string | null;
  bankName: string | null;
  bankCode: string | null;
  accountNumber: string | null;
  walletAddress: string | null;
  message: string;
  needsConfirm: boolean;
}

/**
 * Analyze transcribed voice text with Kimi — returns confirmation message + extracted data
 */
export async function analyzeVoiceWithKimi(text: string): Promise<VoiceAnalysis | null> {
  if (!KIMI_API_KEY || KIMI_API_KEY === 'your_openai_key') {
    return null;
  }

  const content = await callKimi(VOICE_CONFIRM_PROMPT, `User's voice note: "${text}"`, 0.3, 600);
  if (!content) return null;

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    return {
      intent: parsed.intent || 'chat',
      amount: parsed.amount ? Number(parsed.amount) : null,
      recipientName: parsed.recipientName || null,
      bankName: parsed.bankName || null,
      bankCode: parsed.bankCode || null,
      accountNumber: sanitizeAccountNumber(parsed.accountNumber),
      walletAddress: parsed.walletAddress || null,
      message: parsed.message || 'I heard you, but I\'m not sure what you want to do.',
      needsConfirm: parsed.needsConfirm || false,
    };
  } catch (err) {
    console.error('[Voice] Kimi analysis parse failed:', err);
    return null;
  }
}
