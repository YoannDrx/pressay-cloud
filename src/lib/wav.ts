import { ApiError } from './errors.ts';

export interface WavMetadata {
  channels: number;
  sampleRate: number;
  durationSeconds: number;
}

const MAX_CLOUD_AUDIO_BYTES = 4_000_000;
const MAX_CLOUD_AUDIO_SECONDS = 180;

function chunkName(bytes: Buffer, offset: number): string {
  return bytes.toString('ascii', offset, offset + 4);
}

export function parseCloudWav(bytes: Buffer): WavMetadata {
  if (bytes.length < 44 || bytes.length > MAX_CLOUD_AUDIO_BYTES) {
    throw new ApiError(422, 'invalid_audio', 'Audio must be a WAV file under 4 MB');
  }
  if (chunkName(bytes, 0) !== 'RIFF' || chunkName(bytes, 8) !== 'WAVE') {
    throw new ApiError(422, 'invalid_audio', 'Audio must be a RIFF/WAVE file');
  }

  let offset = 12;
  let format:
    | {
        audioFormat: number;
        channels: number;
        sampleRate: number;
        byteRate: number;
        blockAlign: number;
        bitsPerSample: number;
      }
    | undefined;
  let dataBytes = 0;

  while (offset + 8 <= bytes.length) {
    const name = chunkName(bytes, offset);
    const size = bytes.readUInt32LE(offset + 4);
    const contentOffset = offset + 8;
    const contentEnd = contentOffset + size;
    if (contentEnd > bytes.length) {
      throw new ApiError(422, 'invalid_audio', 'WAV chunk exceeds file bounds');
    }
    if (name === 'fmt ' && size >= 16) {
      format = {
        audioFormat: bytes.readUInt16LE(contentOffset),
        channels: bytes.readUInt16LE(contentOffset + 2),
        sampleRate: bytes.readUInt32LE(contentOffset + 4),
        byteRate: bytes.readUInt32LE(contentOffset + 8),
        blockAlign: bytes.readUInt16LE(contentOffset + 12),
        bitsPerSample: bytes.readUInt16LE(contentOffset + 14),
      };
    } else if (name === 'data') {
      dataBytes += size;
    }
    offset = contentEnd + (size % 2);
  }

  if (!format || dataBytes === 0) {
    throw new ApiError(422, 'invalid_audio', 'WAV format or audio data is missing');
  }
  const expectedBlockAlign = format.channels * 2;
  const expectedByteRate = format.sampleRate * expectedBlockAlign;
  if (
    format.audioFormat !== 1 ||
    format.bitsPerSample !== 16 ||
    ![1, 2].includes(format.channels) ||
    format.sampleRate < 8_000 ||
    format.sampleRate > 48_000 ||
    format.blockAlign !== expectedBlockAlign ||
    format.byteRate !== expectedByteRate
  ) {
    throw new ApiError(
      422,
      'unsupported_audio_format',
      'Audio must be 16-bit PCM WAV at 8–48 kHz, mono or stereo',
    );
  }

  const durationSeconds = dataBytes / format.byteRate;
  if (durationSeconds <= 0 || durationSeconds > MAX_CLOUD_AUDIO_SECONDS) {
    throw new ApiError(
      422,
      'unsupported_audio_duration',
      'Cloud audio must be at most 180 seconds',
    );
  }
  return {
    channels: format.channels,
    sampleRate: format.sampleRate,
    durationSeconds,
  };
}

export const cloudAudioLimits = Object.freeze({
  bytes: MAX_CLOUD_AUDIO_BYTES,
  seconds: MAX_CLOUD_AUDIO_SECONDS,
});
