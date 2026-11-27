import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAccountDeletionBatch = vi.hoisted(() => vi.fn());
const cleanupExpiredRateLimitBuckets = vi.hoisted(() => vi.fn());
const purgeExpiredRecords = vi.hoisted(() => vi.fn());

vi.mock('../src/services/account-deletion.ts', () => ({
  runAccountDeletionBatch,
}));
vi.mock('../src/services/rate-limits.ts', () => ({
  cleanupExpiredRateLimitBuckets,
}));
vi.mock('../src/services/retention.ts', () => ({ purgeExpiredRecords }));
const runOpsDigest = vi.hoisted(() => vi.fn());
vi.mock('../src/services/ops-digest.ts', () => ({ runOpsDigest }));

import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';

const cronSecret = 'cron-test-secret-at-least-32-characters';

describe('internal operational routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.CRON_SECRET = cronSecret;
    clearEnvironmentCacheForTests();
    runAccountDeletionBatch.mockResolvedValue({
      claimed: 1,
      completed: 1,
      failed: 0,
      drained: true,
    });
    cleanupExpiredRateLimitBuckets.mockResolvedValue(12);
    purgeExpiredRecords.mockResolvedValue({
      idempotencyRecords: 3,
      operationsRequests: 2,
      usageReservations: 0,
      providerEvents: 1,
      legacySessions: 0,
      legacyVerifications: 0,
    });
  });

  it('rejects requests without the Vercel cron bearer secret', async () => {
    const response = await app.request('/v1/internal/jobs/account-deletions');
    expect(response.status).toBe(401);
    expect(runAccountDeletionBatch).not.toHaveBeenCalled();
  });

  it('runs deletions and bounded operational cleanup for an authenticated cron', async () => {
    const response = await app.request('/v1/internal/jobs/account-deletions', {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
      drained: true,
      rateLimitBucketsDeleted: 12,
      purged: {
        idempotencyRecords: 3,
        operationsRequests: 2,
        usageReservations: 0,
        providerEvents: 1,
        legacySessions: 0,
        legacyVerifications: 0,
      },
    });
    expect(runAccountDeletionBatch).toHaveBeenCalledWith(500, {
      deadlineAt: expect.any(Number) as number,
    });
    const options = runAccountDeletionBatch.mock.calls[0]?.[1] as {
      deadlineAt: number;
    };
    expect(options.deadlineAt - Date.now()).toBeLessThanOrEqual(50_000);
    expect(cleanupExpiredRateLimitBuckets).toHaveBeenCalledOnce();
    expect(purgeExpiredRecords).toHaveBeenCalledOnce();
  });

  it('reports referral reward progress for an authenticated cron', async () => {
    const response = await app.request('/v1/internal/jobs/referral-rewards', {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      processed: 0,
      attempted: 0,
      drained: true,
    });
  });

  it('runs the daily operations digest only for the authenticated cron', async () => {
    runOpsDigest.mockResolvedValue({ attention: false, delivery: 'not_configured' });
    expect((await app.request('/v1/internal/jobs/ops-digest')).status).toBe(401);
    expect(runOpsDigest).not.toHaveBeenCalled();
    const response = await app.request('/v1/internal/jobs/ops-digest', {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      attention: false,
      delivery: 'not_configured',
    });
  });
});
