import { describe, expect, it } from 'vitest';

import { parseCloudWav } from '../src/lib/wav.ts';

function pcmWav(seconds: number, sampleRate = 16_000): Buffer {
  const dataSize = seconds * sampleRate * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

describe('Cloud WAV validation', () => {
  it('derives duration from trusted PCM headers and data size', () => {
    expect(parseCloudWav(pcmWav(2))).toEqual({
      channels: 1,
      sampleRate: 16_000,
      durationSeconds: 2,
    });
  });

  it('rejects malformed and oversized-duration audio', () => {
    expect(() => parseCloudWav(Buffer.alloc(44))).toThrow(
      expect.objectContaining({ code: 'invalid_audio' }),
    );
    expect(() => parseCloudWav(pcmWav(181, 8_000))).toThrow(
      expect.objectContaining({ code: 'unsupported_audio_duration' }),
    );
  });
});
