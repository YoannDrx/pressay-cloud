import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn());
const processCloudTransformation = vi.hoisted(() => vi.fn());
const processCloudTranscription = vi.hoisted(() => vi.fn());

vi.mock('../src/auth.ts', () => ({
  getAuth: () => ({
    api: { getSession },
    handler: vi.fn(),
  }),
}));
vi.mock('../src/services/cloud-processing.ts', () => ({
  processCloudTransformation,
  processCloudTranscription,
}));

import app from '../src/app.ts';

const deviceId = 'a2f99183-9727-4ec5-b0db-34388737dc81';

describe('Cloud routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({
      user: { id: 'auth-user', email: 'person@example.com' },
      session: { id: 'session' },
    });
  });

  it('requires idempotency and explicit content-transfer acknowledgement', async () => {
    const withoutKey = await app.request('/v1/cloud/transformations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        transcript: 'source',
        instruction: 'clean',
        contentTransferAcknowledged: true,
      }),
    });
    expect(withoutKey.status).toBe(422);

    const withoutConsent = await app.request('/v1/cloud/transformations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'transform-route-key-0001',
      },
      body: JSON.stringify({
        deviceId,
        transcript: 'source',
        instruction: 'clean',
        contentTransferAcknowledged: false,
      }),
    });
    expect(withoutConsent.status).toBe(422);
    expect(processCloudTransformation).not.toHaveBeenCalled();
  });

  it('returns the stable transformation alias without exposing provider configuration', async () => {
    processCloudTransformation.mockResolvedValue({
      text: 'final',
      modelAlias: 'pressay-transform-v1',
      operationId: 'safe-operation-id',
    });
    const response = await app.request('/v1/cloud/transformations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'transform-route-key-0002',
      },
      body: JSON.stringify({
        deviceId,
        transcript: 'source',
        instruction: 'clean',
        contentTransferAcknowledged: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: 'final',
      modelAlias: 'pressay-transform-v1',
      operationId: 'safe-operation-id',
    });
  });

  it('rejects audio unless the multipart request acknowledges transfer', async () => {
    const form = new FormData();
    form.set('deviceId', deviceId);
    form.set(
      'audio',
      new File([Buffer.alloc(44)], 'recording.wav', { type: 'audio/wav' }),
    );
    const response = await app.request('/v1/cloud/transcriptions', {
      method: 'POST',
      headers: { 'idempotency-key': 'transcribe-route-key-0001' },
      body: form,
    });
    expect(response.status).toBe(422);
    expect(processCloudTranscription).not.toHaveBeenCalled();
  });
});
