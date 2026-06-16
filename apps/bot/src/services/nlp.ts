/**
 * NLP Service for Zend Bot
 * Parses natural language commands for Nigerian crypto payments
 *
 * ARCHITECTURE:
 * 1. Local regex parser (fast, zero latency, works offline)
 * 2. QVAC local LLM fallback (private, no API cost, sovereign AI)
 *
 * Previously used Kimi (Moonshot) cloud API — now fully local via QVAC.
 */

import { NIGERIAN_BANKS } from '@zend/shared';
import { callQVACLLM } from './qvac/llm.js';
import { transcribeWithQVAC } from './qvac/transcribe.js';
import { extractTextFromImage, parseReceiptImage, type ParsedReceipt } from './qvac/ocr.js';
import { generateEmbedding, indexTransaction, searchTransactions } from './qvac/embed.js';
import { translateForProcessing, translateText, detectLanguage, getLangName, type SupportedLang } from './qvac/translate.js';
import {
  COMMAND_PARSER_PROMPT,
  MENU_PARSE_PROMPT,
  CHAT_SYSTEM_PROMPT,
  VOICE_CONFIRM_PROMPT,
  RECEIPT_PARSER_PROMPT,
  TX_SUMMARY_PROMPT,
} from './qvac/prompts.js';

// ─── Re-export QVAC capabilities for upstream use ───
export { extractTextFromImage, parseReceiptImage, type ParsedReceipt } from './qvac/ocr.js';
export { generateEmbedding, indexTransaction, searchTransactions } from './qvac/embed.js';
export { translateText, detectLanguage, translateForProcessing, getLangName, type SupportedLang } from './qvac/translate.js';

// ─── Types ───

export interface ParsedCommand {
  intent: 'send' | 'add_naira' | 'cash_out' | 'balance' | 'bridge' | 'unknown';
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
  if (/\b(add|deposit|fund|receive|get)\b.*\b(naira|ngn)\b/.test(lower)) {
    return 'add_naira';
  }
  if (/\bwant to receive\b/.test(lower) && /\b(naira|ngn|\d)/.test(lower)) {
    return 'add_naira';
  }
  if (/\b(cash out|withdraw|off.?ramp)\b/.test(lower)) {
    return 'cash_out';
  }
  if (/\b(balance|how much|what.*have)\b/.test(lower)) {
    return 'balance';
  }
  if (/\b(bridge|cross.chain|deposit from|receive from)\b/.test(lower)) {
    return 'bridge';
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

// ─── Kimi Coding API ───

const KIMI_API_KEY = process.env.KIMI_API_KEY || process.env.OPENAI_API_KEY;
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-for-coding';

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
  const text = data?.content?.[0]?.text;
  if (text) return text;
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

// ─── QVAC Local LLM Fallback ───

async function callQVAC(systemPrompt: string, userPrompt: string, temperature: number, maxTokens: number): Promise<string | null> {
  return callQVACLLM({
    systemPrompt,
    userPrompt,
    temperature,
    maxTokens,
    jsonMode: false,
  });
}

// ─── Command Parser ───

/**
 * Parse using QVAC local LLM (for complex/voice transcribed text)
 * Falls back to local parser if QVAC is unavailable.
 */
export async function parseWithQVAC(text: string): Promise<ParsedCommand> {
  const content = await callQVAC(COMMAND_PARSER_PROMPT, text, 0.1, 500);
  if (!content) {
    console.log('[NLP] QVAC LLM unavailable, falling back to local parser');
    return parseLocal(text);
  }

  try {
    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    let intent = parsed.intent || 'unknown';
    if (intent === 'receive') intent = 'add_naira';

    return {
      intent,
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
    console.error('[NLP] QVAC parse failed:', err);
    return parseLocal(text);
  }
}

/** Skip slow LLM parsing for casual chat — reserve QVAC for payment-like text. */
export function looksLikePaymentCommand(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\d{10}/.test(text)) return true;
  if (/\b\d+\s*k\b/i.test(text)) return true;
  if (/\b(send|transfer|pay|add naira|cash out|withdraw|balance|swap|deposit|bridge)\b/i.test(lower)) return true;
  if (/\b(receive|get|add)\b.*\b(naira|ngn|\d)/i.test(lower)) return true;
  if (/\b(gtb|gtbank|uba|access|zenith|opay|kuda|moniepoint|palmpay|first bank|fcmb|wema)\b/i.test(lower)) return true;
  return false;
}

/** Fast path for greetings — no LLM needed. */
export function isCasualGreeting(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!?.]+$/g, '');
  return /^(hi|hello|hey|holla|howdy|sup|yo|good morning|good afternoon|good evening)$/.test(t)
    || /^how far$/.test(t)
    || /^how you dey$/.test(t)
    || /^wetin dey$/.test(t);
}

/**
 * Main parse function - tries local first, falls back to QVAC LLM for payment-like text only
 */
export async function parseCommand(text: string, useAI = false): Promise<ParsedCommand> {
  if (useAI) {
    return parseWithQVAC(text);
  }

  const local = parseLocal(text);

  if (local.intent !== 'unknown') {
    return local;
  }

  if (!looksLikePaymentCommand(text)) {
    return local;
  }

  return parseWithQVAC(text);
}

// ─── Menu Flow AI Parser ───
// Parses free-text user input during menu-driven flows (send, cash out, etc.)

export interface MenuParseResult {
  success: boolean;
  amount?: number;
  recipientName?: string;
  bankCode?: string;
  bankName?: string;
  accountNumber?: string;
  fromToken?: 'USDT' | 'USDC' | 'SOL';
  message?: string;
}

export async function parseMenuInputWithAI(text: string): Promise<MenuParseResult | null> {
  const content = await callQVAC(MENU_PARSE_PROMPT, text, 0.1, 600);
  if (!content) return null;

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    let bankCode = parsed.bankCode || null;
    let bankName = parsed.bankName || null;
    if (bankCode) {
      const bank = NIGERIAN_BANKS.find(b => b.code === bankCode);
      if (bank) {
        bankName = bank.name;
      } else {
        const fuzzy = NIGERIAN_BANKS.find(b =>
          b.name.toLowerCase() === (bankName || '').toLowerCase() ||
          b.name.toLowerCase().includes((bankName || '').toLowerCase())
        );
        if (fuzzy) {
          bankCode = fuzzy.code;
          bankName = fuzzy.name;
        } else {
          bankCode = null;
          bankName = null;
        }
      }
    }

    let accountNumber = parsed.accountNumber || null;
    if (accountNumber) {
      const digits = accountNumber.replace(/\D/g, '');
      accountNumber = digits.length === 10 ? digits : null;
    }

    return {
      success: parsed.success === true,
      amount: parsed.amount ? Number(parsed.amount) : undefined,
      recipientName: parsed.recipientName || undefined,
      bankCode: bankCode || undefined,
      bankName: bankName || undefined,
      accountNumber: accountNumber || undefined,
      fromToken: parsed.fromToken || undefined,
      message: parsed.message || undefined,
    };
  } catch (err) {
    console.error('[MenuParse] AI parse failed:', err);
    return null;
  }
}

// ─── Conversational AI (Smart Assistant) ───


export interface BotFeature {
  key: string;
  name: string;
  description: string;
  category: string;
}

function buildChatSystemPrompt(features: BotFeature[]): string {
  const activeFeatures = features.filter(f => f.category !== 'disabled');
  const featureList = activeFeatures.map((f, i) => `${i + 1}. ${f.name} — ${f.description}`).join('\n');

  return `You are Zend, a friendly Nigerian payment assistant inside a Telegram bot.

Your personality: Warm, concise, helpful. Speak like a knowledgeable Nigerian friend. Light Pidgin like "No wahala" or "Sharp sharp" is fine when natural.

EXACT features Zend has (do NOT mention anything else):
${featureList || '1. Check balance — Dollars (USDT/USDC) and SOL with live Naira rates'}

EXACT features Zend does NOT have (never mention these):
- NO airtime recharge
- NO data bundles
- NO bill payments (electricity, cable, etc.)
- NO loans or borrowing
- NO betting or gambling
- NO stocks or investment trading

If asked about fees: 1% Zend fee paid in SOL + small network fee. If you don't have enough SOL for the network fee, we cover it and add 0.5% to the Zend fee (so 1.5% total).
If asked about security: your account is protected with encryption and PIN. We handle identity verification for compliance.
Keep replies under 150 words. End with a nudge to try something real.`;
}

export interface ChatReply {
  reply: string;
  suggestedAction?: string;
}

/**
 * Get a conversational reply from QVAC local LLM when the user's message is not a command.
 */

export async function chatWithKimi(text: string, features?: BotFeature[]): Promise<ChatReply | null> {
  const systemPrompt = buildChatSystemPrompt(features || []);
  const reply = await callKimi(systemPrompt, text, 0.7, 400);
  if (!reply) return null;
  return { reply: reply.trim() };
}

export async function chatWithAI(text: string, features?: BotFeature[]): Promise<ChatReply | null> {
  const systemPrompt = features?.length
    ? buildChatSystemPrompt(features)
    : CHAT_SYSTEM_PROMPT;
  const reply = await callQVAC(systemPrompt, text, 0.7, 200);
  if (!reply) return null;
  return { reply: reply.trim() };
}

// ─── Voice Transcription (QVAC Whisper) ───

export async function transcribeVoice(audioBuffer: Buffer): Promise<string> {
  return transcribeWithQVAC(audioBuffer);
}

// ─── Voice Confirmation AI ───

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
 * Analyze transcribed voice text with QVAC — returns confirmation message + extracted data
 */
export async function analyzeVoiceWithAI(text: string): Promise<VoiceAnalysis | null> {
  const content = await callQVAC(VOICE_CONFIRM_PROMPT, `User's voice note: "${text}"`, 0.3, 600);
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
    console.error('[Voice] QVAC analysis parse failed:', err);
    return null;
  }
}


// ─── Bulk Send Parser ───

const BULK_SEND_BANK_CODES = [
  'GTB','UBA','ACC','ZEN','FBN','ECO','WEM','FID','SKY','STA','UNI',
  'KEC','JAB','TIT','GLO','PRO','SUN','PAR','COR','FSD','RAN','NOV',
  'OPY','MON','KUD','PAL','PAG','VFD','CAR','BRA','FAI','FCMB','HER','STE','UNI'
];

const BULK_PARSE_PROMPT = `You are a Nigerian payment parser. Extract recipients from the user's bulk transfer text.

For each recipient, extract:
- amount_ngn: number (parse '50k' as 50000, '1.5k' as 1500, '₦2000' as 2000)
- bank_code: 3-letter code from this list: ${BULK_SEND_BANK_CODES.join(', ')}
- account_number: exactly 10 digits
- account_name: full name of recipient

Bank name mapping:
GTBank/Guaranty Trust → GTB
UBA/United Bank → UBA
Access Bank → ACC
Zenith Bank → ZEN
First Bank → FBN
Ecobank → ECO
Wema Bank → WEM
Fidelity Bank → FID
Polaris Bank/Skye → SKY
Stanbic IBTC → STA
Union Bank → UNI
Keystone Bank → KEC
Jaiz Bank → JAB
Titan Trust → TIT
Globus Bank → GLO
Providus Bank → PRO
SunTrust → SUN
Parallex Bank → PAR
Coronation Merchant → COR
FSDH Merchant → FSD
Rand Merchant → RAN
Nova Merchant → NOV
OPay → OPY
Moniepoint → MON
Kuda → KUD
PalmPay → PAL
Paga → PAG
VFD Microfinance → VFD
Carbon → CAR
Branch → BRA
Fairmoney → FAI
FCMB → FCMB
Heritage → HER
Sterling → STE

Return ONLY a JSON array. No explanation, no markdown.
[
  {"amount_ngn":50000,"bank_code":"GTB","account_number":"0123456789","account_name":"John Doe"}
]

If you cannot parse a line, return null for that entry or omit it.`;

export interface BulkRecipient {
  amount_ngn: number;
  bank_code: string;
  account_number: string;
  account_name: string;
}

export async function parseBulkSendWithAI(text: string): Promise<BulkRecipient[] | null> {
  const content = await callKimi(BULK_PARSE_PROMPT, text, 0.1, 800);
  if (!content) return null;
  try {
    const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((r: any) =>
      r &&
      typeof r.amount_ngn === 'number' && r.amount_ngn >= 100 &&
      typeof r.bank_code === 'string' && BULK_SEND_BANK_CODES.includes(r.bank_code.toUpperCase()) &&
      typeof r.account_number === 'string' && /^\d{10}$/.test(r.account_number) &&
      typeof r.account_name === 'string' && r.account_name.length >= 2
    ).map((r: any) => ({
      amount_ngn: Math.round(r.amount_ngn),
      bank_code: r.bank_code.toUpperCase(),
      account_number: r.account_number,
      account_name: r.account_name.trim(),
    }));
  } catch (err) {
    console.error('[BulkSend] AI parse failed:', err);
    return null;
  }
}

// Backward-compatible alias
export { analyzeVoiceWithAI as analyzeVoiceWithKimi };

// ─── Receipt OCR + LLM Parser ───

/**
 * Parse a receipt/screenshot using QVAC OCR + LLM for structured extraction.
 * Two-stage pipeline: OCR extracts text → LLM parses into JSON.
 */
export async function parseReceiptWithQVAC(imageBuffer: Buffer): Promise<ParsedReceipt | null> {
  // Stage 1: OCR
  let rawText: string;
  try {
    rawText = await extractTextFromImage(imageBuffer);
  } catch (err: any) {
    console.error('[Receipt] OCR failed:', err.message);
    return null;
  }

  if (!rawText || rawText.length < 10) {
    console.log('[Receipt] OCR returned too little text');
    return null;
  }

  // Stage 2: LLM parses OCR text
  const prompt = `OCR text from receipt:\n${rawText}\n\nExtract payment details as JSON.`;
  const content = await callQVACLLM({
    systemPrompt: RECEIPT_PARSER_PROMPT,
    userPrompt: prompt,
    temperature: 0.1,
    maxTokens: 300,
    jsonMode: true,
  });

  if (!content) {
    // Fallback to regex parser
    return parseReceiptImage(imageBuffer).catch(() => null);
  }

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    let amount = parsed.amount ? Number(parsed.amount) : undefined;
    const accountNumber = sanitizeAccountNumber(parsed.accountNumber) || undefined;

    // Guard: if amount equals account number, the LLM confused them — clear amount
    if (amount && accountNumber && amount.toString() === accountNumber) {
      console.warn('[Receipt] LLM confused amount with account number:', amount);
      amount = undefined;
    }
    // Guard: a 10-digit amount without commas/decimals is likely an account number
    if (amount && Number.isInteger(amount) && amount.toString().length === 10) {
      console.warn('[Receipt] Amount looks like a 10-digit account number:', amount);
      amount = undefined;
    }

    return {
      amount,
      bankName: parsed.bankName || undefined,
      accountNumber,
      recipientName: parsed.recipientName || undefined,
      rawText,
    };
  } catch (err) {
    console.error('[Receipt] LLM parse failed:', err);
    return { rawText };
  }
}

// ─── Semantic Transaction Search ───

/**
 * Ask a natural language question about transaction history.
 * Uses QVAC embeddings for semantic search + LLM for summarization.
 */
export async function askTransactionQuestion(
  userId: string,
  question: string
): Promise<string | null> {
  const results = await searchTransactions(userId, question, 8);
  if (results.length === 0) {
    return null;
  }

  const context = results
    .map((r, i) => `${i + 1}. ${r.text}${r.metadata?.amount ? ` (₦${r.metadata.amount})` : ''}`)
    .join('\n');

  const summary = await callQVACLLM({
    systemPrompt: TX_SUMMARY_PROMPT,
    userPrompt: `User question: "${question}"\n\nMatching transactions:\n${context}`,
    temperature: 0.7,
    maxTokens: 300,
  });

  return summary;

}
