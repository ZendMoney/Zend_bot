import { describe, it, expect } from 'vitest';
import { formatNearIntentsError, formatVoiceError } from './api-errors.js';

describe('formatNearIntentsError', () => {
  it('maps refundTo errors', () => {
    const err = new Error(
      'NearIntents 400: {"message":"refundTo is not valid","correlationId":"abc"}'
    );
    expect(formatNearIntentsError(err)).toContain('support');
  });

  it('shows human minimum when decimals provided', () => {
    const err = new Error(
      'NearIntents 400: {"message":"Amount is too low for bridge, try at least 80654506743476286791266"}'
    );
    expect(formatNearIntentsError(err, { symbol: 'NEAR', decimals: 24 })).toContain('NEAR');
  });

  it('maps internal server errors', () => {
    const err = new Error(
      'NearIntents 400: {"message":"Internal server error","correlationId":"abc"}'
    );
    expect(formatNearIntentsError(err)).toContain('temporarily busy');
  });

  it('handles timeouts', () => {
    expect(formatNearIntentsError(new Error('Whisper transcription timed out after 60000ms'))).toContain('too long');
  });

  it('handles varchar overflow', () => {
    const err = new Error('PostgresError: value too long for type character varying(44)');
    expect(formatNearIntentsError(err)).toContain('database');
  });
});

describe('formatVoiceError', () => {
  it('maps QVAC transcription failures', () => {
    expect(formatVoiceError(new Error('QVAC transcription failed: Whisper timed out'))).toContain('transcribe');
  });

  it('maps ffmpeg failures', () => {
    expect(formatVoiceError(new Error('ffmpeg conversion failed'))).toContain('temporarily unavailable');
  });
});