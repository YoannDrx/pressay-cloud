import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));

import { clearEnvironmentCacheForTests } from '../src/env.ts';
import {
  bootstrapAccount,
  bootstrapWebAccount,
  getMe,
  getUsage,
  listDevices,
} from '../src/services/accounts.ts';

const authUserId = 'auth-user-1';
const accountId = '00000000-0000-4000-8000-000000000001';
const deviceId = '00000000-0000-4000-8000-000000000002';
const deviceSecret = 'test-device-secret-that-is-at-least-32-characters';

describe('account service', () => {
  beforeEach(() => {
    query.mockReset();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.DEVICE_IDENTIFIER_HMAC_SECRET = deviceSecret;
    clearEnvironmentCacheForTests();
  });

  it('bootstraps with an HMAC and never sends the raw device identifier to SQL', async () => {
    query.mockResolvedValueOnce([
      {
        account_id: accountId,
        account_created: true,
        device_id: deviceId,
        entitlement_tier: 'pro',
        entitlement_source: 'trial',
        entitlement_valid_from: '2026-08-17T00:00:00.000Z',
        entitlement_valid_until: '2026-08-31T00:00:00.000Z',
        entitlement_offline_grace_until: '2026-09-03T00:00:00.000Z',
        entitlement_revision: '1',
      },
    ]);

    const rawIdentifier = 'pressay-device:stable-id';
    const result = await bootstrapAccount(authUserId, {
      deviceIdentifier: rawIdentifier,
      displayName: 'MacBook Air',
      appVariant: 'direct',
      appVersion: '2.0.0-beta.1',
    });

    const expectedHash = createHmac('sha256', deviceSecret)
      .update(rawIdentifier)
      .digest('hex');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      authUserId,
      expectedHash,
      'MacBook Air',
      'direct',
      '2.0.0-beta.1',
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toContain(rawIdentifier);
    expect(result).toMatchObject({ accountId, created: true, deviceId });
  });

  it('maps the atomic three-device rejection to a stable conflict', async () => {
    query.mockRejectedValueOnce(new Error('device_limit_reached'));
    await expect(
      bootstrapAccount(authUserId, {
        deviceIdentifier: 'pressay-device:another-id',
        displayName: 'Mac mini',
        appVariant: 'mas',
        appVersion: '2.0.0',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'device_limit_reached' });
  });

  it('bootstraps web access without a device identifier', async () => {
    query.mockResolvedValueOnce([
      {
        account_id: accountId,
        account_created: true,
        entitlement_tier: 'free',
        entitlement_source: 'none',
        entitlement_valid_from: '2026-08-23T00:00:00.000Z',
        entitlement_valid_until: null,
        entitlement_offline_grace_until: null,
        entitlement_revision: '1',
      },
    ]);

    await expect(bootstrapWebAccount(authUserId)).resolves.toMatchObject({
      accountId,
      created: true,
      entitlement: { tier: 'free', source: 'none' },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('bootstrap_pressay_web_account'),
      [authUserId],
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain('device_identifier');
  });

  it('projects an expired stored Pro entitlement as Free', async () => {
    query.mockResolvedValueOnce([
      {
        account_id: accountId,
        status: 'active',
        created_at: '2026-08-01T00:00:00.000Z',
        tier: 'pro',
        source: 'trial',
        valid_from: '2026-08-01T00:00:00.000Z',
        valid_until: '2026-08-02T00:00:00.000Z',
        offline_grace_until: '2026-08-05T00:00:00.000Z',
        revision: '1',
      },
    ]);

    await expect(getMe(authUserId, 'person@example.com')).resolves.toMatchObject({
      entitlement: { tier: 'free', source: 'none', revision: 1 },
    });
  });

  it('returns only safe device metadata', async () => {
    query.mockResolvedValueOnce([
      {
        id: deviceId,
        display_name: 'MacBook Air',
        app_variant: 'direct',
        app_version: '2.0.0',
        approved: false,
        last_seen_at: '2026-08-17T00:00:00.000Z',
        created_at: '2026-08-17T00:00:00.000Z',
        device_identifier_hash: 'must-not-leak',
      },
    ]);

    const devices = await listDevices(authUserId);
    expect(devices).toEqual([
      {
        id: deviceId,
        displayName: 'MacBook Air',
        appVariant: 'direct',
        appVersion: '2.0.0',
        approved: false,
        lastSeenAt: '2026-08-17T00:00:00.000Z',
        createdAt: '2026-08-17T00:00:00.000Z',
      },
    ]);
  });

  it('returns used, reserved and configured quota independently', async () => {
    query.mockResolvedValueOnce([
      {
        period_start: new Date('2026-08-01T00:00:00.000Z'),
        transcription_seconds_used: '42',
        transcription_seconds_reserved: '8',
        transformations_used: '5',
        transformations_reserved: '1',
        cloud_transcription_seconds: '36000',
        cloud_transformations: '2000',
      },
    ]);

    await expect(getUsage(authUserId)).resolves.toEqual({
      periodStart: '2026-08-01',
      transcription: { usedSeconds: 42, reservedSeconds: 8, limitSeconds: 36000 },
      transformations: { used: 5, reserved: 1, limit: 2000 },
    });
    expect(query.mock.calls[0]?.[0]).toContain(
      "to_char(date_trunc('month', now()), 'YYYY-MM-DD')",
    );
  });
});
