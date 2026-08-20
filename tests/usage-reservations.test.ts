import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));

import {
  claimUsage,
  reserveUsage,
  settleUsage,
} from '../src/services/usage-reservations.ts';

const requestHash = Buffer.alloc(32, 7);

describe('usage reservations', () => {
  beforeEach(() => query.mockReset());

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
