/**
 * QVAC Transcription (Speech-to-Text)
 * Replaces local whisper.cpp binary with QVAC's unified SDK.
 */

import { transcribe, getWhisperModelId } from './index.js';

/**
 * Transcribe audio buffer using QVAC Whisper.
 * Accepts raw audio bytes (OGG Opus from Telegram).
 * Returns transcribed text or throws on failure.
 */
export async function transcribeWithQVAC(audioBuffer: Buffer): Promise<string> {
  const modelId = await getWhisperModelId();
  if (!modelId) {
    throw new Error('QVAC Whisper model not loaded. Run initQVAC() first.');
  }

  try {
    const text = await transcribe({
      modelId,
      audioChunk: audioBuffer,
    });

    return text.trim();
  } catch (err: any) {
    console.error('[QVAC Transcribe] Failed:', err.message || err);
    throw new Error(`QVAC transcription failed: ${err.message || err}`);
  }
}
