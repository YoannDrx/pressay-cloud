import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn());
const bootstrapAccount = vi.hoisted(() => vi.fn());

vi.mock('../src/auth.ts', () => ({
  getAuth: () => ({
    api: {
      getSession,
      revokeSessions: vi.fn(() => Promise.resolve()),
    },
  }),
}));

vi.mock('../src/services/accounts.ts', () => ({
  bootstrapAccount,
  getMe: vi.fn(),
  getUsage: vi.fn(),
  listDevices: vi.fn(),
  requestAccountDeletion: vi.fn(),
  revokeDevice: vi.fn(),
}));

import app from '../src/app.ts';

describe('account routes', () => {
  beforeEach(() => {
    getSession.mockReset();
    bootstrapAccount.mockReset();
  });

  it('rejects an unauthenticated account request', async () => {
    getSession.mockResolvedValueOnce(null);
    const response = await app.request('/v1/me');
    expect(response.status).toBe(401);
  });

  it('rejects an invalid bootstrap body before calling the service', async () => {
    getSession.mockResolvedValueOnce({
      user: { id: 'auth-user', email: 'person@example.com' },
      session: { id: 'session' },
    });
    const response = await app.request('/v1/accounts/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceIdentifier: 'too-short' }),
    });
    expect(response.status).toBe(422);
    expect(bootstrapAccount).not.toHaveBeenCalled();
  });

  it('returns the idempotent bootstrap contract', async () => {
    getSession.mockResolvedValueOnce({
      user: { id: 'auth-user', email: 'person@example.com' },
      session: { id: 'session' },
    });
    bootstrapAccount.mockResolvedValueOnce({
      accountId: '95e286b8-8bf9-4cf6-bf73-fc09361dc88c',
      created: false,
      deviceId: 'a2f99183-9727-4ec5-b0db-34388737dc81',
      entitlement: {
        tier: 'pro',
        source: 'trial',
        validFrom: '2026-08-17T00:00:00.000Z',
        validUntil: '2026-08-31T00:00:00.000Z',
        offlineGraceUntil: '2026-09-03T00:00:00.000Z',
        revision: 1,
      },
    });

    const response = await app.request('/v1/accounts/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceIdentifier: 'pressay-device:stable-id',
        displayName: 'MacBook Air',
        appVariant: 'direct',
        appVersion: '2.0.0-beta.1',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      created: false,
      device: { id: 'a2f99183-9727-4ec5-b0db-34388737dc81' },
    });
  });
});
