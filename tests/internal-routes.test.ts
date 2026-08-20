import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAccountDeletionBatch = vi.hoisted(() => vi.fn());
const cleanupExpiredRateLimitBuckets = vi.hoisted(() => vi.fn());

vi.mock('../src/services/account-deletion.ts', () => ({
  runAccountDeletionBatch,
}));
vi.mock('../src/services/rate-limits.ts', () => ({
  cleanupExpiredRateLimitBuckets,
}));

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
    });
    cleanupExpiredRateLimitBuckets.mockResolvedValue(12);
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
      rateLimitBucketsDeleted: 12,
    });
    expect(runAccountDeletionBatch).toHaveBeenCalledWith(10);
    expect(cleanupExpiredRateLimitBuckets).toHaveBeenCalledOnce();
  });
});
