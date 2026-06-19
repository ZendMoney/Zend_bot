/**
 * QVAC LLM Wrapper
 * Replaces cloud-based Kimi/Moonshot API calls with local inference.
 */

import { completion, getLLMModelId } from './index.js';

/** QVAC allows one completion per model — strictly serialize requests. */
let llmQueue: Promise<unknown> = Promise.resolve();

function enqueueLLM<T>(fn: () => Promise<T>): Promise<T> {
  const run = llmQueue.then(fn, fn);
  llmQueue = run.catch(() => {});
  return run;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Call the local QVAC LLM (replaces callKimi).
 * Returns the full text response, or null if the model isn't loaded or fails.
 */
export async function callQVACLLM(options: LLMOptions): Promise<string | null> {
  return enqueueLLM(() => callQVACLLMUnqueued(options));
}

async function callQVACLLMUnqueued(options: LLMOptions): Promise<string | null> {
  const modelId = await getLLMModelId();
  if (!modelId) {
    console.warn('[QVAC LLM] Model not loaded');
    return null;
  }

  const { systemPrompt, userPrompt, temperature = 0.7, maxTokens = 500, jsonMode = false } = options;

  for (let attempt = 1; attempt <= 3; attempt++) {
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
          predict: maxTokens,
          top_p: 0.9,
          top_k: 40,
        },
        ...(jsonMode
          ? { responseFormat: { type: 'json_object' as const } }
          : {}),
      });

      // Must await the full run — abandoning via timeout leaves the model busy and
      // causes "concurrency policy" rejections on the next request.
      const result = await run.final;
      const text = result.contentText || result.raw?.fullText || '';
      return text.trim();
    } catch (err: any) {
      const msg = err?.message || String(err);
      const busy = msg.includes('concurrency policy') || msg.includes('already running');
      console.error(`[QVAC LLM] Inference failed (attempt ${attempt}/3):`, msg);
      if (busy && attempt < 3) {
        await new Promise((r) => setTimeout(r, 4000 * attempt));
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