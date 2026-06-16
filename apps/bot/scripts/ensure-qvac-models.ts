#!/usr/bin/env node
/**
 * Download QVAC models once into the persistent cache volume.
 * Skips when models are already present (survives Railway redeploys).
 *
 * Usage:
 *   QVAC_MODEL_DIR=/data/qvac npx tsx apps/bot/scripts/ensure-qvac-models.ts
 */

import fs from 'fs';
import path from 'path';
import { loadModel, unloadModel } from '@qvac/sdk';
import * as qvacSdk from '@qvac/sdk';

const registry = qvacSdk as any;
const USE_LIGHT = process.env.QVAC_USE_LIGHT_MODELS === 'true';

const MODEL_DIR = process.env.QVAC_MODEL_DIR?.trim() || '/data/qvac';
const MARKER = path.join(MODEL_DIR, '.zend-qvac-models-ready');

const MODELS = [
  {
    name: USE_LIGHT ? 'LLM (Llama 3.2 1B)' : 'LLM (Qwen3 4B)',
    descriptor: USE_LIGHT ? registry.LLAMA_3_2_1B_INST_Q4_0 : registry.QWEN3_4B_INST_Q4_K_M,
    type: 'llamacpp-completion',
    config: { ctx_size: 4096, temp: 0.7 },
  },
  {
    name: 'Whisper (Tiny)',
    descriptor: registry.WHISPER_TINY_Q8_0,
    type: 'whispercpp-transcription',
    config: { language: 'en' },
  },
  {
    name: 'Embedding (Gemma 300M)',
    descriptor: registry.EMBEDDINGGEMMA_300M_Q4_0,
    type: 'llamacpp-embedding',
  },
  {
    name: 'OCR (Latin)',
    descriptor: registry.OCR_LATIN_RECOGNIZER_1,
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
];

function cacheLooksPopulated(): boolean {
  if (fs.existsSync(MARKER)) return true;
  if (!fs.existsSync(MODEL_DIR)) return false;
  try {
    const entries = fs.readdirSync(MODEL_DIR);
    return entries.some((e) => !e.startsWith('.'));
  } catch {
    return false;
  }
}

async function downloadAll(): Promise<void> {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  console.log(`[QVAC] Model cache: ${MODEL_DIR}`);

  if (cacheLooksPopulated()) {
    console.log('[QVAC] Models already on volume — skipping download');
    return;
  }

  console.log('[QVAC] Cache empty — downloading models (one-time, persisted on volume)...');

  for (const model of MODELS) {
    if (!model.descriptor) {
      console.warn(`[QVAC] Skipping ${model.name} — descriptor not found in SDK`);
      continue;
    }
    console.log(`[QVAC] ⬇️  ${model.name}...`);
    try {
      const modelId = await loadModel({
        modelSrc: model.descriptor,
        modelType: model.type as any,
        modelConfig: model.config,
        onProgress: (progress: { percentage?: number }) => {
          if (progress.percentage !== undefined) {
            process.stdout.write(`   ${progress.percentage.toFixed(1)}%\r`);
          }
        },
      });
      console.log(`   ✅ ${model.name} → ${modelId}`);
      await unloadModel({ modelId });
    } catch (err: any) {
      console.error(`   ❌ ${model.name}: ${err.message || err}`);
      throw err;
    }
  }

  fs.writeFileSync(MARKER, new Date().toISOString());
  console.log('[QVAC] ✅ All models cached on volume');
}

downloadAll().catch((err) => {
  console.error('[QVAC] Model download failed:', err);
  process.exit(1);
});