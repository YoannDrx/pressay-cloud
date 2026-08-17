import { beforeEach, describe, expect, it, vi } from 'vitest';

const reserveUsage = vi.hoisted(() => vi.fn());
const claimUsage = vi.hoisted(() => vi.fn());
const settleUsage = vi.hoisted(() => vi.fn());
const transformWithOpenAI = vi.hoisted(() => vi.fn());
const transcribeWithOpenAI = vi.hoisted(() => vi.fn());
const assertCloudProcessingEnabled = vi.hoisted(() => vi.fn());

vi.mock('../src/services/usage-reservations.ts', () => ({
  reserveUsage,
  claimUsage,
  settleUsage,
}));
vi.mock('../src/services/openai-provider.ts', () => ({
  transformWithOpenAI,
  transcribeWithOpenAI,
}));
vi.mock('../src/services/rate-limits.ts', () => ({
  assertCloudProcessingEnabled,
}));

import {
  processCloudTransformation,
  processCloudTranscription,
} from '../src/services/cloud-processing.ts';

const reservationId = '17195ddc-a08d-4e0d-a7f1-06d7ccae48b0';
const deviceId = 'a2f99183-9727-4ec5-b0db-34388737dc81';

function pcmWav(seconds: number): Buffer {
  const sampleRate = 16_000;
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

describe('Cloud processing orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveUsage.mockResolvedValue({
      id: reservationId,
      status: 'reserved',
      units: 1,
      expiresAt: '2026-08-17T00:10:00.000Z',
    });
    claimUsage.mockResolvedValue(true);
    settleUsage.mockResolvedValue('finalized');
  });

  it('reserves, claims and settles a transformation without persisting content', async () => {
    transformWithOpenAI.mockResolvedValue({
      text: 'Texte propre.',
      operationId: 'resp_safe_id',
    });
    const result = await processCloudTransformation(
      'auth-user',
      {
        deviceId,
        transcript: 'texte brut',
        instruction: 'Nettoyer',
        contentTransferAcknowledged: true,
      },
      'transform-unique-key-0001',
    );
    expect(result).toEqual({
      text: 'Texte propre.',
      operationId: 'resp_safe_id',
      modelAlias: 'pressay-transform-v1',
    });
    expect(reserveUsage).toHaveBeenCalledWith(
      'auth-user',
      deviceId,
      'cloud_transformation',
      1,
      'transform-unique-key-0001',
      expect.any(Buffer),
    );
    expect(settleUsage).toHaveBeenCalledWith(reservationId, true, 'resp_safe_id');
  });

  it('bills verified WAV duration and releases quota after provider failure', async () => {
    transcribeWithOpenAI.mockRejectedValue(new Error('provider unavailable'));
    await expect(
      processCloudTranscription(
        'auth-user',
        deviceId,
        pcmWav(2),
        'fr',
        'transcribe-unique-key-0001',
      ),
    ).rejects.toMatchObject({ code: 'cloud_provider_unavailable' });
    expect(reserveUsage).toHaveBeenCalledWith(
      'auth-user',
      deviceId,
      'cloud_transcription',
      2,
      'transcribe-unique-key-0001',
      expect.any(Buffer),
    );
    expect(settleUsage).toHaveBeenCalledWith(reservationId, false);
  });

  it('never calls the provider twice for a claimed idempotency key', async () => {
    claimUsage.mockResolvedValue(false);
    await expect(
      processCloudTransformation(
        'auth-user',
        {
          deviceId,
          transcript: 'same input',
          instruction: 'Clean',
          contentTransferAcknowledged: true,
        },
        'transform-unique-key-0002',
      ),
    ).rejects.toMatchObject({ code: 'request_already_handled' });
    expect(transformWithOpenAI).not.toHaveBeenCalled();
  });
});
