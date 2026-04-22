import { parseAmountInput, normalizeBank } from '@zend/shared';
import type { ParsedIntent, Entity } from '@zend/shared';

// Kimi (Moonshot) Configuration
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.5';

// Intent types for Zend
const ZEND_INTENTS = [
  'NGN_SEND',
  'NGN_RECEIVE',
  'CRYPTO_SEND',
  'CRYPTO_RECEIVE',
  'SWAP',
  'BALANCE',
  'HISTORY',
  'VAULT_SAVE',
  'VAULT_LOCK',
  'VAULT_WITHDRAW',
  'SCHEDULE',
  'SETTINGS',
  'HELP',
  'GREETING',
  'UNKNOWN',
] as const;

interface KimiMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface KimiResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Parse user input using Kimi AI
 * Falls back to rule-based parsing if Kimi is not configured
 */
export async function parseUserInput(text: string): Promise<ParsedIntent> {
  // Try rule-based first for speed
  const ruleBased = parseRuleBased(text);
  if (ruleBased.confidence > 0.9) {
    return ruleBased;
  }

  // Fall back to Kimi AI for complex queries
  if (KIMI_API_KEY) {
    try {
      return await parseWithKimi(text);
    } catch (err) {
      console.error('Kimi parsing failed:', err);
    }
  }

  return ruleBased;
}

/**
 * Rule-based parsing for common patterns
 */
function parseRuleBased(text: string): ParsedIntent {
  const lower = text.toLowerCase().trim();
  const entities: Entity[] = [];
  let intent = 'UNKNOWN';
  let confidence = 0.5;

  // Greeting
  if (lower.match(/^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)/)) {
    intent = 'GREETING';
    confidence = 1.0;
    return { intent, confidence, entities, rawText: text };
  }

  // Balance queries
  if (lower.match(/balance|how much|wetin be my balance|show my balance|check balance/)) {
    intent = 'BALANCE';
    confidence = 0.95;
    return { intent, confidence, entities, rawText: text };
  }

  // Send money (NGN)
  if (lower.match(/send|transfer|give|send money|transfer money/)) {
    intent = 'NGN_SEND';
    confidence = 0.85;

    // Parse amount
    const amount = parseAmountInput(text);
    if (amount) {
      entities.push({ type: 'amount', value: amount.value });
      if (amount.currency) entities.push({ type: 'currency', value: amount.currency });
      confidence = 0.95;
    }

    // Parse bank
    const bank = normalizeBank(text);
    if (bank) {
      entities.push({ type: 'bank', value: bank.code });
      entities.push({ type: 'bank_name', value: bank.name });
    }

    // Parse account number
    const accountMatch = text.match(/(\d{10})/);
    if (accountMatch) {
      entities.push({ type: 'account_number', value: accountMatch[1] });
    }

    // Parse recipient name (rough heuristic)
    const nameMatch = text.match(/(?:send|transfer|give)\s+(?:\d+k?|\d+,?\d*)\s*(?:naira|ngn|usdt)?\s+(?:to)?\s+([a-z\s]+?)(?:\s+(?:at|for|via|using|to))?\s*(?:gtb|gtbank|uba|access|zenith|first bank|fbn|ecobank|wema|fidelity|polaris|stanbic|union|$)/i);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (name && name.length > 1) {
        entities.push({ type: 'recipient_name', value: name });
      }
    }

    return { intent, confidence, entities, rawText: text };
  }

  // Receive / Add money / Buy
  if (lower.match(/buy|add|fund|deposit|receive|top up|wan add|add money|fund wallet/)) {
    intent = 'NGN_RECEIVE';
    confidence = 0.9;
    return { intent, confidence, entities, rawText: text };
  }

  // Sell / Withdraw / Cash out
  if (lower.match(/sell|withdraw|cash out|withdraw money|convert to naira/)) {
    intent = 'CRYPTO_SEND'; // Actually off-ramp
    confidence = 0.85;

    const amount = parseAmountInput(text);
    if (amount) {
      entities.push({ type: 'amount', value: amount.value });
      if (amount.currency) entities.push({ type: 'currency', value: amount.currency });
    }

    return { intent, confidence, entities, rawText: text };
  }

  // Swap
  if (lower.match(/swap|convert|exchange|change|turn|convert my/)) {
    intent = 'SWAP';
    confidence = 0.85;

    // Detect from/to tokens
    const tokens = ['sol', 'usdt', 'usdc', 'bonk', 'jup', 'ray'];
    const foundTokens: string[] = [];
    for (const token of tokens) {
      if (lower.includes(token)) foundTokens.push(token.toUpperCase());
    }
    if (foundTokens.length >= 1) {
      entities.push({ type: 'from_asset', value: foundTokens[0] });
    }
    if (foundTokens.length >= 2) {
      entities.push({ type: 'to_asset', value: foundTokens[1] });
    }

    // Amount
    const amount = parseAmountInput(text);
    if (amount) {
      entities.push({ type: 'amount', value: amount.value });
      if (amount.currency) entities.push({ type: 'currency', value: amount.currency });
    }

    return { intent, confidence, entities, rawText: text };
  }

  // History
  if (lower.match(/history|transactions|past transfers|my history|show history/)) {
    intent = 'HISTORY';
    confidence = 0.9;
    return { intent, confidence, entities, rawText: text };
  }

  // Vault / Save
  if (lower.match(/save|vault|savings|auto.save|autosave/)) {
    if (lower.match(/lock|locked|time.lock|fix|tie/)) {
      intent = 'VAULT_LOCK';
    } else if (lower.match(/withdraw|remove|take out|break/)) {
      intent = 'VAULT_WITHDRAW';
    } else {
      intent = 'VAULT_SAVE';
    }
    confidence = 0.85;

    const amount = parseAmountInput(text);
    if (amount) {
      entities.push({ type: 'amount', value: amount.value });
      if (amount.currency) entities.push({ type: 'currency', value: amount.currency });
    }

    // Parse percentage for auto-save
    const percentMatch = text.match(/(\d+)%?\s*(?:of|percent)/);
    if (percentMatch) {
      entities.push({ type: 'percentage', value: parseInt(percentMatch[1]) });
    }

    return { intent, confidence, entities, rawText: text };
  }

  // Schedule
  if (lower.match(/schedule|recurring|auto pay|standing order|every week|every month|every sunday/)) {
    intent = 'SCHEDULE';
    confidence = 0.85;

    const amount = parseAmountInput(text);
    if (amount) {
      entities.push({ type: 'amount', value: amount.value });
      if (amount.currency) entities.push({ type: 'currency', value: amount.currency });
    }

    // Frequency
    if (lower.match(/daily|every day/)) entities.push({ type: 'frequency', value: 'daily' });
    else if (lower.match(/weekly|every week/)) entities.push({ type: 'frequency', value: 'weekly' });
    else if (lower.match(/monthly|every month/)) entities.push({ type: 'frequency', value: 'monthly' });

    return { intent, confidence, entities, rawText: text };
  }

  // Settings
  if (lower.match(/settings|preference|language|pin|email|notification|voice/)) {
    intent = 'SETTINGS';
    confidence = 0.85;
    return { intent, confidence, entities, rawText: text };
  }

  // Help
  if (lower.match(/help|how to|what can you do|commands|assist|support/)) {
    intent = 'HELP';
    confidence = 0.95;
    return { intent, confidence, entities, rawText: text };
  }

  // Receive / Show account
  if (lower.match(/my account|account number|deposit address|receive money|show address/)) {
    intent = 'CRYPTO_RECEIVE';
    confidence = 0.9;
    return { intent, confidence, entities, rawText: text };
  }

  return { intent, confidence, entities, rawText: text };
}

/**
 * Parse user input using Kimi AI (Moonshot)
 * Uses Anthropic-style /v1/messages endpoint
 */
async function parseWithKimi(text: string): Promise<ParsedIntent> {
  const systemPrompt = `You are a Nigerian financial assistant parser. Extract intent and entities from user messages.

Available intents: ${ZEND_INTENTS.join(', ')}

Entity types:
- amount (number)
- currency (NGN, USDT, USDC, SOL)
- bank (GTB, UBA, ACC, ZEN, FBN, etc.)
- account_number (10 digits)
- recipient_name (string)
- from_asset (SOL, USDT, USDC, BONK)
- to_asset (SOL, USDT, USDC, BONK)
- percentage (number)
- frequency (daily, weekly, monthly)

Respond ONLY with JSON in this format:
{
  "intent": "INTENT_NAME",
  "confidence": 0.0-1.0,
  "entities": [
    {"type": "amount", "value": 50000},
    {"type": "bank", "value": "GTB"}
  ]
}`;

  const userPrompt = `Parse this Nigerian financial command: "${text}"`;

  const response = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KIMI_API_KEY}`,
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 500,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    throw new Error(`Kimi API error: ${response.status}`);
  }

  const data = await response.json() as KimiResponse;
  const content = data.choices[0]?.message?.content || '';

  // Parse JSON response
  let result: any;
  try {
    // Extract JSON if wrapped in markdown
    let jsonText = content;
    if (content.includes('```json')) {
      jsonText = content.split('```json')[1].split('```')[0];
    } else if (content.includes('```')) {
      jsonText = content.split('```')[1].split('```')[0];
    }
    result = JSON.parse(jsonText.trim());
  } catch {
    throw new Error('Failed to parse Kimi response as JSON');
  }

  return {
    intent: result.intent || 'UNKNOWN',
    confidence: result.confidence || 0.5,
    entities: result.entities || [],
    rawText: text,
  };
}

/**
 * Quick check if Kimi is configured and reachable
 */
export async function checkKimiStatus(): Promise<{ configured: boolean; model?: string; error?: string }> {
  if (!KIMI_API_KEY) {
    return { configured: false, error: 'KIMI_API_KEY not set' };
  }

  try {
    const response = await fetch(`${KIMI_BASE_URL}/models`, {
      headers: {
        'Authorization': `Bearer ${KIMI_API_KEY}`,
      },
    });

    if (response.ok) {
      return { configured: true, model: KIMI_MODEL };
    } else {
      return { configured: false, error: `HTTP ${response.status}` };
    }
  } catch (err) {
    return { configured: false, error: String(err) };
  }
}
