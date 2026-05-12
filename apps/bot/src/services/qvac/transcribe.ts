/**
 * QVAC Transcription (Speech-to-Text)
 * Converts Telegram OGG Opus voice messages to WAV, then transcribes via QVAC Whisper.
 */

import { writeFile, unlink, readFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { transcribe, getWhisperModelId } from './index.js';

const execAsync = promisify(exec);

async function saveTemp(buffer: Buffer, ext: string): Promise<string> {
  const path = join(tmpdir(), `qvac_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  await writeFile(path, buffer);
  return path;
}

async function convertToWav(oggPath: string): Promise<string> {
  const wavPath = oggPath.replace(/\.ogg$/, '.wav');
  // Convert OGG Opus → 16kHz mono WAV (whisper optimal format)
  await execAsync(
    `ffmpeg -y -i "${oggPath}" -ar 16000 -ac 1 -c:a pcm_s16le -f wav "${wavPath}"`,
    { timeout: 30000 }
  );
  // Ensure WAV data chunk has even byte count (s16le requires multiples of 2)
  const stat = await readFile(wavPath);
  if (stat.length % 2 !== 0) {
    await appendFile(wavPath, Buffer.from([0x00]));
  }
  return wavPath;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Transcribe Telegram voice message (OGG Opus → WAV → Whisper).
 */
export async function transcribeWithQVAC(audioBuffer: Buffer): Promise<string> {
  const modelId = await getWhisperModelId();
  if (!modelId) {
    throw new Error('QVAC Whisper model not loaded. Run initQVAC() first.');
  }

  let oggPath: string | undefined;
  let wavPath: string | undefined;

  try {
    // Save OGG buffer to temp file
    oggPath = await saveTemp(audioBuffer, 'ogg');

    // Convert to WAV for whisper
    const t0 = Date.now();
    wavPath = await convertToWav(oggPath);
    console.log(`[QVAC Transcribe] WAV conversion took ${Date.now() - t0}ms`);

    const t1 = Date.now();
    const text = await withTimeout(
      transcribe({
        modelId,
        audioChunk: wavPath,
        prompt: 'This is a Nigerian Pidgin English voice message about money transfer or banking.',
      }),
      30000,
      'Whisper transcription'
    ) as string;
    console.log(`[QVAC Transcribe] Inference took ${Date.now() - t1}ms`);

    return text.trim();
  } catch (err: any) {
    console.error('[QVAC Transcribe] Failed:', err.message || err);
    throw new Error(`QVAC transcription failed: ${err.message || err}`);
  } finally {
    try { if (oggPath) await unlink(oggPath); } catch { /* ignore */ }
    try { if (wavPath) await unlink(wavPath); } catch { /* ignore */ }
  }
}
