/**
 * QVAC Service — Local-first AI for ZendPay Bot
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
import { createThrottledProgressLogger } from '../../utils/qvac-progress.js';

import * as qvacSdk from '@qvac/sdk';
const registryModels = qvacSdk as any;

const QWEN3_4B_INST_Q4_K_M = registryModels.QWEN3_4B_INST_Q4_K_M;
const LLAMA_3_2_1B_INST_Q4_0 = registryModels.LLAMA_3_2_1B_INST_Q4_0;
const WHISPER_TINY_Q8_0 = registryModels.WHISPER_TINY_Q8_0;
const EMBEDDINGGEMMA_300M_Q4_0 = registryModels.EMBEDDINGGEMMA_300M_Q4_0;
const OCR_LATIN_RECOGNIZER_1 = registryModels.OCR_LATIN_RECOGNIZER_1;
const AFRICAN_4B_TRANSLATION_Q4_K_M = registryModels.AFRICAN_4B_TRANSLATION_Q4_K_M;

// ─── Memory tuning (Railway) ───
// Default: lazy load + keep at most 1 model in RAM (~500MB–1GB vs ~2–4GB for all four).

export const QVAC_ENABLED = process.env.QVAC_ENABLED !== 'false';
const USE_LIGHT_MODELS = process.env.QVAC_USE_LIGHT_MODELS !== 'false';
const QVAC_PRELOAD_MODELS = process.env.QVAC_PRELOAD_MODELS === 'true';
const MAX_LOADED_MODELS = Math.max(
  1,
  parseInt(process.env.QVAC_MAX_LOADED_MODELS || '1', 10) || 1,
);
const IDLE_UNLOAD_MS = parseInt(process.env.QVAC_IDLE_UNLOAD_MS || '300000', 10) || 0;
const LLM_CTX_SIZE = USE_LIGHT_MODELS ? 2048 : 4096;

export const MODELS = {
  llm: USE_LIGHT_MODELS ? LLAMA_3_2_1B_INST_Q4_0 : QWEN3_4B_INST_Q4_K_M,
  whisper: WHISPER_TINY_Q8_0,
  embed: EMBEDDINGGEMMA_300M_Q4_0,
  ocr: OCR_LATIN_RECOGNIZER_1,
  translation: AFRICAN_4B_TRANSLATION_Q4_K_M,
} as const;

type ModelKey = keyof typeof MODELS;

const MODEL_RUNTIME: Record<
  ModelKey,
  { type: string; config?: Record<string, unknown> }
> = {
  llm: { type: 'llamacpp-completion', config: { ctx_size: LLM_CTX_SIZE, temp: 0.7 } },
  whisper: { type: 'whispercpp-transcription', config: { language: 'en' } },
  embed: { type: 'llamacpp-embedding' },
  ocr: {
    type: 'ocr',
    config: {
      langList: ['en'],
      magRatio: 1.0,
      contrastRetry: false,
      lowConfidenceThreshold: 0.5,
      recognizerBatchSize: 1,
      timeout: 30000,
    },
  },
  translation: { type: 'nmtcpp-translation' },
};

const loadedModels = new Map<ModelKey, string>();
const loadPromises = new Map<ModelKey, Promise<string | null>>();
const idleTimers = new Map<ModelKey, NodeJS.Timeout>();
let _initPromise: Promise<void> | null = null;

export interface QVACStatus {
  enabled: boolean;
  ready: boolean;
  lazyMode: boolean;
  maxLoadedModels: number;
  loadedCount: number;
  models: Record<string, boolean>;
  errors: string[];
}

function runtimeConfig(key: ModelKey): Record<string, unknown> | undefined {
  return MODEL_RUNTIME[key].config;
}

async function unloadModelByKey(key: ModelKey): Promise<void> {
  const timer = idleTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(key);
  }

  const modelId = loadedModels.get(key);
  if (!modelId) return;

  try {
    await unloadModel({ modelId });
    console.log(`[QVAC] Unloaded ${MODELS[key].name} (freed RAM)`);
  } catch {
    // ignore
  }
  loadedModels.delete(key);
}

async function evictModelsIfNeeded(keepKey: ModelKey): Promise<void> {
  if (loadedModels.size < MAX_LOADED_MODELS) return;

  const keysToEvict = [...loadedModels.keys()].filter((k) => k !== keepKey);
  for (const key of keysToEvict) {
    if (loadedModels.size < MAX_LOADED_MODELS) break;
    await unloadModelByKey(key);
  }
}

function scheduleIdleUnload(key: ModelKey): void {
  if (IDLE_UNLOAD_MS <= 0) return;

  const existing = idleTimers.get(key);
  if (existing) clearTimeout(existing);

  idleTimers.set(
    key,
    setTimeout(() => {
      void unloadModelByKey(key);
    }, IDLE_UNLOAD_MS),
  );
}

function touchModel(key: ModelKey): void {
  scheduleIdleUnload(key);
}

async function loadModelOnce(key: ModelKey): Promise<string | null> {
  if (!QVAC_ENABLED) return null;

  const existing = loadedModels.get(key);
  if (existing) {
    touchModel(key);
    return existing;
  }

  const inflight = loadPromises.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    await evictModelsIfNeeded(key);

    const descriptor = MODELS[key];
    const { type } = MODEL_RUNTIME[key];
    console.log(`[QVAC] Loading model: ${descriptor.name} ...`);

    try {
      const modelId = await loadModel({
        modelSrc: descriptor,
        modelType: type as any,
        modelConfig: runtimeConfig(key),
        onProgress: createThrottledProgressLogger(descriptor.name, 10),
      });

      loadedModels.set(key, modelId);
      touchModel(key);
      console.log(`[QVAC] ✅ Loaded ${descriptor.name} → ${modelId} (${loadedModels.size}/${MAX_LOADED_MODELS} in RAM)`);
      return modelId;
    } catch (err: any) {
      console.error(`[QVAC] ❌ Failed to load ${descriptor.name}:`, err.message || err);
      return null;
    } finally {
      loadPromises.delete(key);
    }
  })();

  loadPromises.set(key, promise);
  return promise;
}

/** Startup hook — does NOT load all models unless QVAC_PRELOAD_MODELS=true */
export async function initQVAC(): Promise<void> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    if (!QVAC_ENABLED) {
      console.log('[QVAC] Disabled (QVAC_ENABLED=false) — regex-only NLP');
      return;
    }

    const cacheDir = process.env.QVAC_MODEL_DIR || '(SDK default ~/.qvac/models)';
    const configPath = process.env.QVAC_CONFIG_PATH || '(auto-discover qvac.config.*)';
    console.log('[QVAC] Local AI enabled');
    console.log(`[QVAC] Cache: ${cacheDir} | config: ${configPath}`);
    console.log(
      `[QVAC] Memory policy: max ${MAX_LOADED_MODELS} model(s) in RAM, ctx=${LLM_CTX_SIZE}` +
        (IDLE_UNLOAD_MS > 0 ? `, idle unload ${Math.round(IDLE_UNLOAD_MS / 60000)}m` : ''),
    );
    if (USE_LIGHT_MODELS) {
      console.log('[QVAC] Lightweight LLM (QVAC_USE_LIGHT_MODELS=true)');
    }

    if (QVAC_PRELOAD_MODELS) {
      console.log('[QVAC] Preloading all models (QVAC_PRELOAD_MODELS=true) — high RAM usage');
      await Promise.all([
        loadModelOnce('llm'),
        loadModelOnce('whisper'),
        loadModelOnce('embed'),
        loadModelOnce('ocr'),
      ]);
      console.log('[QVAC] Preload complete.');
    } else {
      console.log('[QVAC] Lazy load — models load on first voice/OCR/LLM request');
    }
  })();

  return _initPromise;
}

export function getQVACStatus(): QVACStatus {
  const status: QVACStatus = {
    enabled: QVAC_ENABLED,
    ready: QVAC_ENABLED,
    lazyMode: !QVAC_PRELOAD_MODELS,
    maxLoadedModels: MAX_LOADED_MODELS,
    loadedCount: loadedModels.size,
    models: {},
    errors: [],
  };

  for (const key of Object.keys(MODELS) as ModelKey[]) {
    status.models[key] = loadedModels.has(key);
  }

  if (!QVAC_ENABLED) {
    status.ready = false;
    status.errors.push('QVAC disabled');
  }

  return status;
}

export async function shutdownQVAC(): Promise<void> {
  for (const key of [...loadedModels.keys()]) {
    await unloadModelByKey(key);
  }
  loadPromises.clear();
  _initPromise = null;
}

export async function getLLMModelId(): Promise<string | null> {
  return loadModelOnce('llm');
}

export async function getWhisperModelId(): Promise<string | null> {
  return loadModelOnce('whisper');
}

export async function getEmbedModelId(): Promise<string | null> {
  return loadModelOnce('embed');
}

export async function getOCRModelId(): Promise<string | null> {
  return loadModelOnce('ocr');
}

export async function getTranslationModelId(): Promise<string | null> {
  return loadModelOnce('translation');
}

export { completion, transcribe, embed, ocr, translate, textToSpeech };
export type { CompletionRun, OCRTextBlock };