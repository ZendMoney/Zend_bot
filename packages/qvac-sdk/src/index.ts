// Stub for @qvac/sdk — QVAC local AI SDK
// Replace with actual SDK when available: https://github.com/tetherto/qvac

export interface CompletionRun {
  final: Promise<CompletionFinal>;
  events: AsyncIterable<CompletionEvent>;
}

export interface CompletionFinal {
  contentText?: string;
  raw?: { fullText?: string };
}

export interface CompletionEvent {
  type: 'contentDelta' | 'done';
  text?: string;
}

export interface OCRTextBlock {
  text: string;
  bbox: number[];
}

export interface LoadModelOptions {
  modelSrc: any;
  modelType: string;
  modelConfig?: Record<string, any>;
  onProgress?: (progress: { percentage?: number; loaded?: number; total?: number }) => void;
}

export interface EmbedOptions {
  modelId: string;
  text: string;
}

export interface EmbedResult {
  embedding: number[];
}

export async function loadModel(opts: LoadModelOptions): Promise<string> {
  console.warn('[QVAC Stub] loadModel called — SDK not installed');
  return 'stub-model-id';
}

export async function unloadModel(opts: { modelId: string }): Promise<void> {
  console.warn('[QVAC Stub] unloadModel called — SDK not installed');
}

export function completion(opts: {
  modelId: string;
  history?: Array<{ role: string; content: string }>;
  stream?: boolean;
  generationParams?: Record<string, any>;
  responseFormat?: { type: string };
}): CompletionRun {
  console.warn('[QVAC Stub] completion called — SDK not installed');
  return {
    final: Promise.resolve({ contentText: '', raw: { fullText: '' } }),
    events: (async function* () { yield { type: 'done' as const }; })(),
  };
}

export function transcribe(opts: {
  modelId: string;
  audioChunk: string | Buffer;
  prompt?: string;
  language?: string;
}): Promise<{ text: string }> {
  console.warn('[QVAC Stub] transcribe called — SDK not installed');
  return Promise.resolve({ text: '' });
}

export function embed(opts: EmbedOptions): Promise<EmbedResult> {
  console.warn('[QVAC Stub] embed called — SDK not installed');
  return Promise.resolve({ embedding: [] });
}

export function ocr(opts: {
  modelId: string;
  image: string | Buffer;
  options?: Record<string, any>;
}): Promise<{ blocks: OCRTextBlock[] }> {
  console.warn('[QVAC Stub] ocr called — SDK not installed');
  return Promise.resolve({ blocks: [] });
}

export function translate(opts: {
  modelId: string;
  text: string;
  sourceLang?: string;
  targetLang?: string;
  from?: string;
  to?: string;
}): Promise<string> {
  console.warn('[QVAC Stub] translate called — SDK not installed');
  return Promise.resolve(opts.text);
}

export async function textToSpeech(text: string): Promise<Buffer> {
  console.warn('[QVAC Stub] textToSpeech called — SDK not installed');
  return Buffer.from([]);
}

// Model constants
export const QWEN3_4B_INST_Q4_K_M = { name: 'qwen3-4b-instruct-q4_k_m', modelId: 'qwen3-4b' };
export const LLAMA_3_2_1B_INST_Q4_0 = { name: 'llama-3.2-1b-instruct-q4_0', modelId: 'llama-3.2-1b' };
export const WHISPER_TINY_Q8_0 = { name: 'whisper-tiny-q8_0', modelId: 'whisper-tiny' };
export const EMBEDDINGGEMMA_300M_Q4_0 = { name: 'embedding-gemma-300m-q4_0', modelId: 'gemma-300m' };
export const OCR_LATIN_RECOGNIZER_1 = { name: 'ocr-latin-recognizer-1', modelId: 'ocr-latin' };
export const AFRICAN_4B_TRANSLATION_Q4_K_M = { name: 'african-4b-translation-q4_k_m', modelId: 'african-4b' };
