#!/usr/bin/env node
/**
 * QVAC Model Downloader
 * Pre-downloads all AI models needed by Zend for local inference.
 *
 * Usage:
 *   npx tsx apps/bot/scripts/download-qvac-models.ts
 */

import { loadModel, unloadModel } from '@qvac/sdk';

// Model constants are exported at runtime from the main SDK entry.
import * as qvacSdk from '@qvac/sdk';
const registryModels = qvacSdk as any;

const QWEN3_4B_INST_Q4_K_M = registryModels.QWEN3_4B_INST_Q4_K_M;
const WHISPER_TINY_Q8_0 = registryModels.WHISPER_TINY_Q8_0;
const EMBEDDINGGEMMA_300M_Q4_0 = registryModels.EMBEDDINGGEMMA_300M_Q4_0;
const OCR_0_6B_MULTIMODAL_Q4_K_M = registryModels.OCR_0_6B_MULTIMODAL_Q4_K_M;
const AFRICAN_4B_TRANSLATION_Q4_K_M = registryModels.AFRICAN_4B_TRANSLATION_Q4_K_M;

const MODELS = [
  { name: 'LLM (Qwen3 4B)', descriptor: QWEN3_4B_INST_Q4_K_M, type: 'llm' },
  { name: 'Whisper (Tiny)', descriptor: WHISPER_TINY_Q8_0, type: 'whisper' },
  { name: 'Embedding (Gemma 300M)', descriptor: EMBEDDINGGEMMA_300M_Q4_0, type: 'embeddings' },
  { name: 'OCR (0.6B Multimodal)', descriptor: OCR_0_6B_MULTIMODAL_Q4_K_M, type: 'ocr' },
  { name: 'Translation (African 4B)', descriptor: AFRICAN_4B_TRANSLATION_Q4_K_M, type: 'nmt' },
];

async function downloadAll() {
  console.log('📥 Zend QVAC Model Downloader\n');

  for (const model of MODELS) {
    console.log(`⬇️  Downloading ${model.name}...`);
    try {
      const modelId = await loadModel({
        modelSrc: model.descriptor,
        modelType: model.type as any,
        onProgress: (progress: { percentage?: number }) => {
          if (progress.percentage !== undefined) {
            process.stdout.write(`   ${progress.percentage.toFixed(1)}%\r`);
          }
        },
      });
      console.log(`   ✅ Loaded → ${modelId}`);
      await unloadModel({ modelId });
    } catch (err: any) {
      console.error(`   ❌ Failed: ${err.message || err}`);
    }
    console.log('');
  }

  console.log('🎉 All downloads complete!');
}

downloadAll().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
