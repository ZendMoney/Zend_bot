/**
 * QVAC Service — Local-first AI for Zend Bot
 * Replaces all cloud AI (Kimi/Moonshot) with on-device inference.
 * Uses Tether's QVAC SDK: https://github.com/tetherto/qvac
 */

import {
  loadModel,
  unloadModel,
  completion,
  transcribe,
  embed,
  ocr,
  translate,
  textToSpeech,
  type CompletionRun,
  type OCRTextBlock,
} from '@qvac/sdk';

// QVAC model constants are exported at runtime via barrel files.
// TypeScript's NodeNext resolution cannot trace through them, so we
// @ts-ignore the import and cast to any at the usage sites.
// @ts-ignore
import * as registryModels from '@qvac/sdk/dist/models/registry/models.js';

const QWEN3_4B_INST_Q4_K_M = (registryModels as any).QWEN3_4B_INST_Q4_K_M;
const WHISPER_TINY_Q8_0 = (registryModels as any).WHISPER_TINY_Q8_0;
const EMBEDDINGGEMMA_300M_Q4_0 = (registryModels as any).EMBEDDINGGEMMA_300M_Q4_0;
const OCR_0_6B_MULTIMODAL_Q4_K_M = (registryModels as any).OCR_0_6B_MULTIMODAL_Q4_K_M;
const AFRICAN_4B_TRANSLATION_Q4_K_M = (registryModels as any).AFRICAN_4B_TRANSLATION_Q4_K_M;

// ─── Model Configuration ───

export const MODELS = {
  llm: QWEN3_4B_INST_Q4_K_M,
  whisper: WHISPER_TINY_Q8_0,
  embed: EMBEDDINGGEMMA_300M_Q4_0,
  ocr: OCR_0_6B_MULTIMODAL_Q4_K_M,
  translation: AFRICAN_4B_TRANSLATION_Q4_K_M,
} as const;

// Cache of loaded model IDs
const loadedModels = new Map<string, string>();
let _initPromise: Promise<void> | null = null;

export interface QVACStatus {
  ready: boolean;
  models: Record<string, boolean>;
  errors: string[];
}

// ─── Model Loading ───

async function loadModelOnce(key: keyof typeof MODELS, modelType: string, modelConfig?: Record<string, any>): Promise<string | null> {
  if (loadedModels.has(key)) return loadedModels.get(key)!;

  const descriptor = MODELS[key];
  console.log(`[QVAC] Loading model: ${descriptor.name} ...`);

  try {
    const modelId = await loadModel({
      modelSrc: descriptor,
      modelType: modelType as any,
      modelConfig,
      onProgress: (progress: { percentage?: number; loaded?: number; total?: number }) => {
        if (progress.percentage !== undefined) {
          console.log(`[QVAC] ${descriptor.name}: ${progress.percentage.toFixed(1)}%`);
        }
      },
    });

    loadedModels.set(key, modelId);
    console.log(`[QVAC] ✅ Loaded ${descriptor.name} → ${modelId}`);
    return modelId;
  } catch (err: any) {
    console.error(`[QVAC] ❌ Failed to load ${descriptor.name}:`, err.message || err);
    return null;
  }
}

/** Pre-load all models on startup (optional — models are lazy-loaded otherwise) */
export async function initQVAC(): Promise<void> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    console.log('[QVAC] Initializing local AI stack...');

    await Promise.all([
      loadModelOnce('llm', 'llm', { ctx_size: 4096, temp: 0.7 }),
      loadModelOnce('whisper', 'whisper', { language: 'en' }),
      loadModelOnce('embed', 'embeddings'),
      loadModelOnce('ocr', 'ocr'),
      loadModelOnce('translation', 'nmt'),
    ]);

    console.log('[QVAC] Initialization complete.');
  })();

  return _initPromise;
}

/** Get current status of all models */
export function getQVACStatus(): QVACStatus {
  const status: QVACStatus = {
    ready: true,
    models: {},
    errors: [],
  };

  for (const key of Object.keys(MODELS) as Array<keyof typeof MODELS>) {
    const loaded = loadedModels.has(key);
    status.models[key] = loaded;
    if (!loaded) status.ready = false;
  }

  return status;
}

/** Unload all models to free memory */
export async function shutdownQVAC(): Promise<void> {
  for (const [key, modelId] of loadedModels) {
    try {
      await unloadModel({ modelId });
      console.log(`[QVAC] Unloaded ${key}`);
    } catch {
      // ignore
    }
  }
  loadedModels.clear();
  _initPromise = null;
}

// ─── Lazy Getters ───

export async function getLLMModelId(): Promise<string | null> {
  return loadModelOnce('llm', 'llm', { ctx_size: 4096 });
}

export async function getWhisperModelId(): Promise<string | null> {
  return loadModelOnce('whisper', 'whisper', { language: 'en' });
}

export async function getEmbedModelId(): Promise<string | null> {
  return loadModelOnce('embed', 'embeddings');
}

export async function getOCRModelId(): Promise<string | null> {
  return loadModelOnce('ocr', 'ocr');
}

export async function getTranslationModelId(): Promise<string | null> {
  return loadModelOnce('translation', 'nmt');
}

// ─── Convenience Exports ───

export { completion, transcribe, embed, ocr, translate, textToSpeech };
export type { CompletionRun, OCRTextBlock };
