import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrapAccount = vi.hoisted(() => vi.fn());
const bootstrapWebAccount = vi.hoisted(() => vi.fn());
const requestAccountDeletion = vi.hoisted(() => vi.fn());

vi.mock('../src/services/accounts.ts', () => ({
  bootstrapAccount,
  recordAccountContact: vi.fn(),
  bootstrapWebAccount,
  getMe: vi.fn(),
  getUsage: vi.fn(),
  listDevices: vi.fn(),
  requestAccountDeletion,
  revokeDevice: vi.fn(),
}));

import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { bearer, configureTestIdentity, webProxyToken } from './helpers/identity.ts';

describe('account routes', () => {
  beforeEach(() => {
    bootstrapAccount.mockReset();
    bootstrapWebAccount.mockReset();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    clearEnvironmentCacheForTests();
    configureTestIdentity();
  });

  it('rejects an unauthenticated account request', async () => {
    const response = await app.request('/v1/me');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="pressay-api"');
  });

  it('accepts the short-lived signed web proxy identity', async () => {
    const token = await webProxyToken('web-auth-user');
    const response = await app.request('/v1/accounts/bootstrap', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ deviceIdentifier: 'too-short' }),
    });
    expect(response.status).toBe(422);
  });

  it('rejects an invalid bootstrap body before calling the service', async () => {
    const response = await app.request('/v1/accounts/bootstrap', {
      method: 'POST',
      headers: { ...(await bearer()), 'content-type': 'application/json' },
      body: JSON.stringify({ deviceIdentifier: 'too-short' }),
    });
    expect(response.status).toBe(422);
    expect(bootstrapAccount).not.toHaveBeenCalled();
  });

  it('returns the idempotent bootstrap contract', async () => {
    bootstrapAccount.mockResolvedValueOnce({
      accountId: '00000000-0000-4000-8000-000000000001',
      created: false,
      deviceId: '00000000-0000-4000-8000-000000000002',
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
      headers: { ...(await bearer()), 'content-type': 'application/json' },
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
      device: { id: '00000000-0000-4000-8000-000000000002' },
    });
  });

  it('bootstraps a Free web account without a device payload', async () => {
    bootstrapWebAccount.mockResolvedValueOnce({
      accountId: '00000000-0000-4000-8000-000000000001',
      created: true,
      entitlement: {
        tier: 'free',
        source: 'none',
        validFrom: '2026-08-23T00:00:00.000Z',
        validUntil: null,
        offlineGraceUntil: null,
        revision: 1,
      },
    });

    const response = await app.request('/v1/accounts/web-bootstrap', {
      method: 'POST',
      headers: await bearer(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      created: true,
      entitlement: { tier: 'free', source: 'none' },
    });
    expect(bootstrapWebAccount).toHaveBeenCalledWith('auth-user');
  });

  it('forwards an explicit App Store acknowledgement on account deletion', async () => {
    requestAccountDeletion.mockResolvedValue(undefined);
    const plain = await app.request('/v1/me', {
      method: 'DELETE',
      headers: await bearer(),
    });
    expect(plain.status).toBe(202);
    expect(requestAccountDeletion).toHaveBeenLastCalledWith('auth-user', {
      acknowledgeAppleSubscription: false,
    });
    await app.request('/v1/me?acknowledgeAppleSubscription=true', {
      method: 'DELETE',
      headers: await bearer(),
    });
    expect(requestAccountDeletion).toHaveBeenLastCalledWith('auth-user', {
      acknowledgeAppleSubscription: true,
    });
  });

  it('returns the App Store conflict envelope with the subscriptions link', async () => {
    const { ApiError } = await import('../src/lib/errors.ts');
    requestAccountDeletion.mockRejectedValue(
      new ApiError(
        409,
        'apple_subscription_active',
        'Cancel first',
        {},
        {
          manageSubscriptionsUrl: 'https://apps.apple.com/account/subscriptions',
        },
      ),
    );
    const response = await app.request('/v1/me', {
      method: 'DELETE',
      headers: await bearer(),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'apple_subscription_active',
        manageSubscriptionsUrl: 'https://apps.apple.com/account/subscriptions',
      },
    });
  });
});
