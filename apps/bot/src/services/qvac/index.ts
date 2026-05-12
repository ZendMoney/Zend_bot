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

// Model constants are exported at runtime from the main SDK entry,
// but TypeScript's NodeNext resolution cannot trace through barrel files.
// We import the main SDK namespace and cast to any to access them.
import * as qvacSdk from '@qvac/sdk';
const registryModels = qvacSdk as any;

const QWEN3_4B_INST_Q4_K_M = registryModels.QWEN3_4B_INST_Q4_K_M;
const LLAMA_3_2_1B_INST_Q4_0 = registryModels.LLAMA_3_2_1B_INST_Q4_0;
const WHISPER_TINY_Q8_0 = registryModels.WHISPER_TINY_Q8_0;
const EMBEDDINGGEMMA_300M_Q4_0 = registryModels.EMBEDDINGGEMMA_300M_Q4_0;
const OCR_LATIN_RECOGNIZER_1 = registryModels.OCR_LATIN_RECOGNIZER_1;
const AFRICAN_4B_TRANSLATION_Q4_K_M = registryModels.AFRICAN_4B_TRANSLATION_Q4_K_M;

// ─── Environment-aware Model Selection ───
// Set QVAC_USE_LIGHT_MODELS=true for Railway / resource-constrained deploys

const USE_LIGHT_MODELS = process.env.QVAC_USE_LIGHT_MODELS === 'true';

export const MODELS = {
  llm: USE_LIGHT_MODELS ? LLAMA_3_2_1B_INST_Q4_0 : QWEN3_4B_INST_Q4_K_M,
  whisper: WHISPER_TINY_Q8_0,
  embed: EMBEDDINGGEMMA_300M_Q4_0,
  ocr: OCR_LATIN_RECOGNIZER_1,
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
    if (USE_LIGHT_MODELS) {
      console.log('[QVAC] Using lightweight models for deployment (QVAC_USE_LIGHT_MODELS=true)');
    }

    await Promise.all([
      loadModelOnce('llm', 'llamacpp-completion', { ctx_size: 4096, temp: 0.7 }),
      loadModelOnce('whisper', 'whispercpp-transcription', { language: 'en' }),
      loadModelOnce('embed', 'llamacpp-embedding'),
      loadModelOnce('ocr', 'ocr', {
        langList: ['en'],
        magRatio: 1.0,
        contrastRetry: false,
        lowConfidenceThreshold: 0.5,
        recognizerBatchSize: 1,
        timeout: 30000,
      }),
      // Translation is heavy — lazy-load only when needed
      // loadModelOnce('translation', 'nmt'),
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
  return loadModelOnce('llm', 'llamacpp-completion', { ctx_size: 4096 });
}

export async function getWhisperModelId(): Promise<string | null> {
  return loadModelOnce('whisper', 'whispercpp-transcription', { language: 'en' });
}

export async function getEmbedModelId(): Promise<string | null> {
  return loadModelOnce('embed', 'llamacpp-embedding');
}

export async function getOCRModelId(): Promise<string | null> {
  return loadModelOnce('ocr', 'ocr', {
    langList: ['en'],
    magRatio: 1.0,
    contrastRetry: false,
    lowConfidenceThreshold: 0.5,
    recognizerBatchSize: 1,
    timeout: 30000,
  });
}

export async function getTranslationModelId(): Promise<string | null> {
  return loadModelOnce('translation', 'nmtcpp-translation');
}

// ─── Convenience Exports ───

export { completion, transcribe, embed, ocr, translate, textToSpeech };
export type { CompletionRun, OCRTextBlock };
