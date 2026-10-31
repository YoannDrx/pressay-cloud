import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrapAccount = vi.hoisted(() => vi.fn());
const bootstrapWebAccount = vi.hoisted(() => vi.fn());
const requestAccountDeletion = vi.hoisted(() => vi.fn());
const listDevices = vi.hoisted(() => vi.fn());

vi.mock('../src/services/accounts.ts', () => ({
  bootstrapAccount,
  recordAccountContact: vi.fn(),
  bootstrapWebAccount,
  getMe: vi.fn(),
  getUsage: vi.fn(),
  listDevices,
  requestAccountDeletion,
  revokeDevice: vi.fn(),
}));

import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import {
  bearer,
  configureTestIdentity,
  configureTestJwks,
  externalAccessToken,
  webProxyToken,
} from './helpers/identity.ts';

/** Web proxy identity whose session signed in a moment ago. */
async function freshBearer(claims: Record<string, unknown> = {}) {
  return bearer('auth-user', {
    pressay_auth_at: Math.floor(Date.now() / 1000) - 5,
    ...claims,
  });
}

function desktopBody() {
  return {
    deviceIdentifier: 'pressay-device:stable-id',
    displayName: 'Pressay Mac',
    appVariant: 'direct',
    appVersion: '2.1.0',
  };
}

function bootstrapResult() {
  return {
    accountId: '00000000-0000-4000-8000-000000000001',
    created: false,
    deviceId: '00000000-0000-4000-8000-000000000002',
    entitlement: {
      tier: 'free',
      source: 'none',
      validFrom: '2026-10-29T00:00:00.000Z',
      validUntil: null,
      offlineGraceUntil: null,
      revision: 1,
    },
  };
}

describe('account routes', () => {
  beforeEach(() => {
    bootstrapAccount.mockReset();
    bootstrapWebAccount.mockReset();
    listDevices.mockReset();
    requestAccountDeletion.mockReset();
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

  it('registers a client that omits the platform as macOS', async () => {
    bootstrapAccount.mockResolvedValueOnce(bootstrapResult());

    const response = await app.request('/v1/accounts/bootstrap', {
      method: 'POST',
      headers: { ...(await bearer()), 'content-type': 'application/json' },
      body: JSON.stringify(desktopBody()),
    });

    expect(response.status).toBe(200);
    expect(bootstrapAccount).toHaveBeenCalledWith(
      'auth-user',
      expect.objectContaining({ platform: 'macos' }),
    );
  });

  it('accepts a Windows desktop device', async () => {
    bootstrapAccount.mockResolvedValueOnce(bootstrapResult());

    const response = await app.request('/v1/accounts/bootstrap', {
      method: 'POST',
      headers: { ...(await bearer()), 'content-type': 'application/json' },
      body: JSON.stringify({ ...desktopBody(), platform: 'windows' }),
    });

    expect(response.status).toBe(200);
    expect(bootstrapAccount).toHaveBeenCalledWith(
      'auth-user',
      expect.objectContaining({ platform: 'windows' }),
    );
  });

  it('rejects an unknown platform before calling the service', async () => {
    const response = await app.request('/v1/accounts/bootstrap', {
      method: 'POST',
      headers: { ...(await bearer()), 'content-type': 'application/json' },
      body: JSON.stringify({ ...desktopBody(), platform: 'linux' }),
    });

    expect(response.status).toBe(422);
    expect(bootstrapAccount).not.toHaveBeenCalled();
  });

  it('lists devices with their platform', async () => {
    listDevices.mockResolvedValueOnce([
      {
        id: '00000000-0000-4000-8000-000000000002',
        displayName: 'Pressay PC',
        platform: 'windows',
        appVariant: 'direct',
        appVersion: '2.1.0',
        approved: true,
        lastSeenAt: '2026-10-29T00:00:00.000Z',
        createdAt: '2026-10-29T00:00:00.000Z',
      },
    ]);

    const response = await app.request('/v1/devices', { headers: await bearer() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      devices: [expect.objectContaining({ platform: 'windows' })],
      limit: 3,
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
      headers: await freshBearer(),
    });
    expect(plain.status).toBe(202);
    expect(requestAccountDeletion).toHaveBeenLastCalledWith('auth-user', {
      acknowledgeAppleSubscription: false,
    });
    await app.request('/v1/me?acknowledgeAppleSubscription=true', {
      method: 'DELETE',
      headers: await freshBearer(),
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
      headers: await freshBearer(),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'apple_subscription_active',
        manageSubscriptionsUrl: 'https://apps.apple.com/account/subscriptions',
      },
    });
  });

  describe('account deletion freshness', () => {
    const now = () => Math.floor(Date.now() / 1000);

    async function deleteWith(headers: Record<string, string>) {
      return app.request('/v1/me', { method: 'DELETE', headers });
    }

    it('accepts a web session that signed in within ten minutes', async () => {
      requestAccountDeletion.mockResolvedValue(undefined);
      const response = await deleteWith(
        await bearer('auth-user', { pressay_auth_at: now() - 9 * 60 }),
      );
      expect(response.status).toBe(202);
      expect(requestAccountDeletion).toHaveBeenCalledOnce();
    });

    it('accepts a recent second-factor step-up on an older web session', async () => {
      requestAccountDeletion.mockResolvedValue(undefined);
      const response = await deleteWith(
        await bearer('auth-user', {
          pressay_auth_at: now() - 3 * 24 * 3600,
          pressay_step_up_method: 'totp',
          pressay_step_up_at: now() - 60,
        }),
      );
      expect(response.status).toBe(202);
    });

    it.each([
      ['no freshness proof', {}],
      ['a sign-in older than ten minutes', { pressay_auth_at: now() - 601 }],
      ['a sign-in dated in the future', { pressay_auth_at: now() + 120 }],
      ['a non-numeric sign-in time', { pressay_auth_at: String(now()) }],
      [
        'a step-up older than ten minutes',
        { pressay_step_up_method: 'totp', pressay_step_up_at: now() - 601 },
      ],
      [
        'a step-up with an unknown method',
        { pressay_step_up_method: 'password', pressay_step_up_at: now() },
      ],
      ['a fresh sign-in not bound to a session', { pressay_auth_at: now(), sid: '' }],
    ])('refuses a web session with %s', async (_label, claims) => {
      const response = await deleteWith(await bearer('auth-user', claims));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'recent_authentication_required', maxAgeSeconds: '600' },
      });
      expect(requestAccountDeletion).not.toHaveBeenCalled();
    });

    it('keeps the desktop OAuth deletion contract unchanged', async () => {
      requestAccountDeletion.mockResolvedValue(undefined);
      await configureTestJwks();
      try {
        const response = await deleteWith({
          authorization: `Bearer ${await externalAccessToken()}`,
        });
        expect(response.status).toBe(202);
        expect(requestAccountDeletion).toHaveBeenCalledWith('auth-user', {
          acknowledgeAppleSubscription: false,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
