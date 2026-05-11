/**
 * QVAC LLM Wrapper
 * Replaces cloud-based Kimi/Moonshot API calls with local inference.
 */

import { completion, getLLMModelId } from './index.js';

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
  const modelId = await getLLMModelId();
  if (!modelId) {
    console.warn('[QVAC LLM] Model not loaded');
    return null;
  }

  const { systemPrompt, userPrompt, temperature = 0.7, maxTokens = 500, jsonMode = false } = options;

  try {
    const history = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const run = completion({
      modelId,
      history,
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

    const result = await run.final;
    const text = result.content || '';
    return text.trim();
  } catch (err: any) {
    console.error('[QVAC LLM] Inference failed:', err.message || err);
    return null;
  }
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
      if (event.type === 'contentDelta') {
        yield event.text;
      }
    }
  } catch (err: any) {
    console.error('[QVAC LLM] Stream failed:', err.message || err);
  }
}
