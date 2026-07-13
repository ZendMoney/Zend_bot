/**
 * QVAC LLM Wrapper — local on-device inference only.
 */

import { completion, getLLMModelId, shutdownQVAC } from './index.js';

/** Hard cap so Telegraf handlers never hang 3+ minutes on CPU inference. */
const LLM_TIMEOUT_MS = Math.max(
  5_000,
  parseInt(process.env.QVAC_LLM_TIMEOUT_MS || '20000', 10) || 20_000
);

/** QVAC allows one completion per model — strictly serialize requests. */
let llmQueue: Promise<unknown> = Promise.resolve();
let recovering = false;

function enqueueLLM<T>(fn: () => Promise<T>): Promise<T> {
  const run = llmQueue.then(fn, fn);
  // Always clear the queue slot even if fn hangs (we race with timeout inside).
  llmQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Unload models after a stuck inference so the next call can start clean. */
async function recoverFromStuckLlm(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    console.warn('[QVAC LLM] Recovering from stuck inference — unloading models');
    await shutdownQVAC();
  } catch (err: any) {
    console.warn('[QVAC LLM] Recovery unload failed:', err?.message || err);
  } finally {
    recovering = false;
  }
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Call the local QVAC LLM.
 * Returns the full text response, or null if the model isn't loaded, fails, or times out.
 */
export async function callQVACLLM(options: LLMOptions): Promise<string | null> {
  return enqueueLLM(() => callQVACLLMUnqueued(options));
}

async function callQVACLLMUnqueued(options: LLMOptions): Promise<string | null> {
  let modelId: string | null;
  try {
    // Model load on cold start can also hang — bound it.
    modelId = await withTimeout(getLLMModelId(), LLM_TIMEOUT_MS, 'QVAC model load');
  } catch (err: any) {
    console.error('[QVAC LLM] Model load failed:', err?.message || err);
    await recoverFromStuckLlm();
    return null;
  }

  if (!modelId) {
    console.warn('[QVAC LLM] Model not loaded');
    return null;
  }

  const { systemPrompt, userPrompt, temperature = 0.7, maxTokens = 500, jsonMode = false } = options;
  // Cap generation on CPU so predict=500 can't run for minutes
  const predict = Math.min(maxTokens, parseInt(process.env.QVAC_LLM_MAX_TOKENS || '128', 10) || 128);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const run = completion({
        modelId,
        history: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        generationParams: {
          temp: temperature,
          predict,
          top_p: 0.9,
          top_k: 40,
        },
        ...(jsonMode
          ? { responseFormat: { type: 'json_object' as const } }
          : {}),
      });

      const result = await withTimeout<{ contentText?: string; raw?: { fullText?: string } }>(
        run.final as Promise<{ contentText?: string; raw?: { fullText?: string } }>,
        LLM_TIMEOUT_MS,
        'QVAC inference'
      );
      const text = result.contentText || result.raw?.fullText || '';
      return text.trim();
    } catch (err: any) {
      const msg = err?.message || String(err);
      const timedOut = /timed out/i.test(msg);
      const busy = msg.includes('concurrency policy') || msg.includes('already running');
      console.error(`[QVAC LLM] Inference failed (attempt ${attempt}/2):`, msg);

      if (timedOut) {
        await recoverFromStuckLlm();
        return null;
      }
      if (busy && attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Stream LLM response token-by-token.
 * Useful for typing indicators or progressive UI updates.
 */
export async function* streamQVACLLM(options: LLMOptions): AsyncGenerator<string, void, unknown> {
  const modelId = await getLLMModelId();
  if (!modelId) return;

  const { systemPrompt, userPrompt, temperature = 0.7, maxTokens = 500 } = options;

  try {
    const run = completion({
      modelId,
      history: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: true,
      generationParams: {
        temp: temperature,
        predict: maxTokens,
        top_p: 0.9,
        top_k: 40,
      },
    });

    for await (const event of run.events) {
      if (event.type === 'contentDelta' && event.text) {
        yield event.text;
      }
    }
  } catch (err: any) {
    console.error('[QVAC LLM] Stream failed:', err.message || err);
  }
}