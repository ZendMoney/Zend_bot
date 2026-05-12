/**
 * QVAC Transcription (Speech-to-Text)
 * Converts Telegram OGG Opus voice messages to WAV, then transcribes via QVAC Whisper.
 */

import { writeFile, unlink } from 'fs/promises';
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
    `ffmpeg -y -i "${oggPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`,
    { timeout: 30000 }
  );
  return wavPath;
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
    wavPath = await convertToWav(oggPath);

    const text = await transcribe({
      modelId,
      audioChunk: wavPath,
      prompt: 'This is a Nigerian Pidgin English voice message about money transfer or banking.',
    });

    return text.trim();
  } catch (err: any) {
    console.error('[QVAC Transcribe] Failed:', err.message || err);
    throw new Error(`QVAC transcription failed: ${err.message || err}`);
  } finally {
    try { if (oggPath) await unlink(oggPath); } catch { /* ignore */ }
    try { if (wavPath) await unlink(wavPath); } catch { /* ignore */ }
  }
}
