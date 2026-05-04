/**
 * Local STT via whisper.cpp (same pattern as OpenClaw/zeroclaw)
 * Runs entirely on your server — zero external API calls for transcription.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WHISPER_DIR = resolve(__dirname, 'whisper.cpp');
const MODELS_DIR = resolve(__dirname, 'models');
const MODEL_PATH = resolve(MODELS_DIR, 'ggml-tiny.bin');
const MAIN_BINARY = resolve(WHISPER_DIR, 'main');

let _hasWhisper: boolean | null = null;

export function hasWhisper(): boolean {
  if (_hasWhisper !== null) return _hasWhisper;
  _hasWhisper = existsSync(MAIN_BINARY) && existsSync(MODEL_PATH);
  if (!_hasWhisper) {
    console.warn('[whisper] whisper.cpp not found. Run: bash apps/bot/src/services/whisper/setup.sh');
  }
  return _hasWhisper;
}

/**
 * Convert OGG/Opus (Telegram voice) to WAV (16kHz mono) using ffmpeg
 */
function convertToWav(inputPath: string, outputPath: string): void {
  try {
    execSync(
      `ffmpeg -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le -y "${outputPath}"`,
      { stdio: 'pipe' }
    );
  } catch (err: any) {
    throw new Error(`ffmpeg conversion failed: ${err.message}`);
  }
}

/**
 * Transcribe audio buffer using local whisper.cpp
 * @param audioBuffer Raw audio bytes (OGG Opus from Telegram)
 * @returns Transcribed text
 */
export async function transcribeWithWhisper(audioBuffer: Buffer): Promise<string> {
  if (!hasWhisper()) {
    throw new Error(
      'whisper.cpp not set up. Run: bash apps/bot/src/services/whisper/setup.sh'
    );
  }

  const tmpDir = '/tmp/zend_whisper';
  const oggPath = `${tmpDir}/voice.ogg`;
  const wavPath = `${tmpDir}/voice.wav`;

  // Write OGG buffer to temp file
  const fs = await import('fs');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(oggPath, audioBuffer);

  // Convert OGG → WAV (whisper.cpp expects WAV)
  convertToWav(oggPath, wavPath);

  // Run whisper.cpp
  const cmd = `"${MAIN_BINARY}" -m "${MODEL_PATH}" -f "${wavPath}" --no-timestamps -l en -np`;
  const output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });

  // Cleanup
  try {
    fs.unlinkSync(oggPath);
    fs.unlinkSync(wavPath);
  } catch { /* ignore cleanup errors */ }

  // Parse output: whisper.cpp prints each segment like: [00:00:00.000 --> 00:00:05.000]   text here
  // With --no-timestamps it prints just the text lines
  const lines = output
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('[') && !l.includes('-->'));

  return lines.join(' ').trim();
}
