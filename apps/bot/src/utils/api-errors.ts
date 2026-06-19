import { fromBaseUnits } from '@zend/near-intents-client';

/** Turn raw API/transport errors into short, user-facing messages. */

export interface NearIntentsErrorHint {
  symbol?: string;
  decimals?: number;
}

const NEAR_INTENTS_HINTS: Record<string, string> = {
  'refundto is not valid':
    'Deposit setup issue on our side. Please contact support.',
  'amount must be specified in base units':
    'Amount format error — try entering the amount again (e.g. 10 or 50).',
  'amount is too low':
    'Amount is below the minimum for this route. Try a larger deposit.',
  'minamountin':
    'Amount is below the minimum for this route. Try a larger deposit.',
  'no route found':
    'This chain/token pair is not available right now. Try a different token or chain.',
  'unsupported':
    'This chain or token is not supported yet.',
  'recipient is not valid':
    'Your ZendPay wallet address could not be used for this deposit. Contact support.',
  'internal server error':
    'The bridge service is temporarily busy. Please wait a minute and try again.',
  'deadline':
    'The quote expired. Please start the deposit again.',
};

function parseNearIntentsBody(raw: string): string | null {
  const match = raw.match(/NearIntents \d+:\s*(\{[\s\S]*\})/);
  if (!match) return null;
  try {
    const body = JSON.parse(match[1]);
    return typeof body.message === 'string' ? body.message : null;
  } catch {
    return null;
  }
}

export function formatNearIntentsError(err: unknown, hint?: NearIntentsErrorHint): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/value too long for type character varying/i.test(raw)) {
    return 'Could not save your deposit — our database needs an update. Please contact support.';
  }

  if (/not configured/i.test(raw)) {
    return 'Cross-chain deposits are not set up yet. Use 📥 Receive for direct deposits.';
  }

  const apiMessage = parseNearIntentsBody(raw);
  if (apiMessage) {
    const lower = apiMessage.toLowerCase();

    const minMatch = apiMessage.match(/try at least (\d+)/i);
    if (minMatch && hint?.decimals != null) {
      try {
        const minHuman = fromBaseUnits(minMatch[1], hint.decimals);
        const minNum = Number(minHuman);
        const display = Number.isFinite(minNum)
          ? (minNum < 1 ? minNum.toPrecision(2) : minNum.toLocaleString(undefined, { maximumFractionDigits: 4 }))
          : minHuman;
        const sym = hint.symbol || 'token';
        return `Amount is too low. Minimum deposit is ~${display} ${sym}.`;
      } catch {
        // fall through to generic hint
      }
    }

    for (const [key, msg] of Object.entries(NEAR_INTENTS_HINTS)) {
      if (lower.includes(key)) return msg;
    }
    if (apiMessage.length <= 120) return apiMessage;
    return 'Could not get a deposit quote. Please try again.';
  }

  if (/timed out|timeout|abort/i.test(raw)) {
    return 'The bridge service took too long to respond. Please try again.';
  }
  if (/fetch failed|network|econnrefused/i.test(raw)) {
    return 'Could not reach the bridge service. Check your connection and try again.';
  }

  return 'Could not complete this request. Please try again or contact support.';
}

export function formatVoiceError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes('whisper') || lower.includes('transcri')) {
    return 'Could not transcribe your voice note. Speak clearly, keep it under 30 seconds, and try again — or type your command.';
  }
  if (lower.includes('ffmpeg')) {
    return 'Voice processing is temporarily unavailable. Please type your command instead.';
  }
  if (lower.includes('timed out')) {
    return 'Voice processing took too long. Try a shorter voice note or type your command.';
  }
  if (lower.includes('qvac') && lower.includes('not loaded')) {
    return 'Voice AI is still starting up. Wait a moment and try again, or type your command.';
  }
  if (lower.includes('qvac llm')) {
    return 'Could not understand your voice note. Try again or type it, e.g. "Send 5000 to GTB 0123456789".';
  }

  return 'Could not process your voice note. Type your command or use the menu below.';
}