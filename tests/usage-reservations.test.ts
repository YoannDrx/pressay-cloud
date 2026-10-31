import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));

import { clearEnvironmentCacheForTests } from '../src/env.ts';
import {
  claimUsage,
  reserveUsage,
  settleUsage,
} from '../src/services/usage-reservations.ts';

const requestHash = Buffer.alloc(32, 7);

const reservationRow = {
  result_reservation_id: '00000000-0000-4000-8000-000000000003',
  result_status: 'reserved',
  result_units: 60,
  result_expires_at: '2026-08-17T00:10:00.000Z',
};

function reserveTranscription() {
  return reserveUsage(
    'auth-user',
    '00000000-0000-4000-8000-000000000002',
    'cloud_transcription',
    60,
    'operation-idempotency-key',
    requestHash,
  );
}

function useProduction(): void {
  process.env.PRESSAY_DEPLOYMENT_ENV = 'production';
  process.env.ENTITLEMENT_SIGNING_KEY_ID = 'pressay-entitlement-production-2026-01';
  clearEnvironmentCacheForTests();
}

describe('usage reservations', () => {
  beforeEach(() => {
    query.mockReset();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    delete process.env.PRESSAY_DEPLOYMENT_ENV;
    delete process.env.ENTITLEMENT_SIGNING_KEY_ID;
    clearEnvironmentCacheForTests();
  });

  it('refuses Cloud quota to an Apple Sandbox entitlement in production', async () => {
    useProduction();
    query.mockResolvedValueOnce([{ sandbox: true }]);
    await expect(reserveTranscription()).rejects.toMatchObject({
      status: 403,
      code: 'cloud_entitlement_required',
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain('e.sandbox');
    expect(JSON.stringify(query.mock.calls)).not.toContain('reserve_pressay_usage');
  });

  it('reserves Cloud quota for a paid entitlement in production', async () => {
    useProduction();
    query
      .mockResolvedValueOnce([{ sandbox: false }])
      .mockResolvedValueOnce([reservationRow]);
    await expect(reserveTranscription()).resolves.toMatchObject({ status: 'reserved' });
    expect(query.mock.calls[1]?.[0]).toContain('reserve_pressay_usage');
  });

  it('lets the database decide when the account has no entitlement row', async () => {
    useProduction();
    query
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('account_not_active'));
    await expect(reserveTranscription()).rejects.toThrow('account_not_active');
  });

  it('keeps Sandbox entitlements usable for Cloud outside production', async () => {
    process.env.PRESSAY_DEPLOYMENT_ENV = 'staging';
    clearEnvironmentCacheForTests();
    query.mockResolvedValueOnce([reservationRow]);
    await expect(reserveTranscription()).resolves.toMatchObject({ status: 'reserved' });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain('reserve_pressay_usage');
  });

  it('returns the database reservation contract', async () => {
    query.mockResolvedValueOnce([
      {
        result_reservation_id: '00000000-0000-4000-8000-000000000003',
        result_status: 'reserved',
        result_units: 60,
        result_expires_at: '2026-08-17T00:10:00.000Z',
      },
    ]);
    await expect(
      reserveUsage(
        'auth-user',
        '00000000-0000-4000-8000-000000000002',
        'cloud_transcription',
        60,
        'operation-idempotency-key',
        requestHash,
      ),
    ).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000003',
      status: 'reserved',
      units: 60,
      expiresAt: '2026-08-17T00:10:00.000Z',
    });
  });

  it('maps quota exhaustion to an actionable 429', async () => {
    query.mockRejectedValueOnce(new Error('usage_quota_exceeded'));
    await expect(
      reserveUsage(
        'auth-user',
        '00000000-0000-4000-8000-000000000002',
        'cloud_transformation',
        1,
        'operation-idempotency-key',
        requestHash,
      ),
    ).rejects.toMatchObject({ status: 429, code: 'usage_quota_exceeded' });
  });

  it('claims a reserved operation exactly once before calling a provider', async () => {
    query.mockResolvedValueOnce([{ claimed: true }]);
    await expect(claimUsage('00000000-0000-4000-8000-000000000003')).resolves.toBe(
      true,
    );
  });

  it('settles a reservation idempotently through PostgreSQL', async () => {
    query.mockResolvedValueOnce([{ status: 'finalized' }]);
    await expect(
      settleUsage('00000000-0000-4000-8000-000000000003', true, 'provider-operation'),
    ).resolves.toBe('finalized');
  });
});
