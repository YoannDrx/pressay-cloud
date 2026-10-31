import { runReferralRewards } from '../services/referrals.js';
import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import { getEnvironment, requireEnvironmentValue } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { writeLog } from '../lib/logger.js';
import { runAccountDeletionBatch } from '../services/account-deletion.js';
import { cleanupExpiredRateLimitBuckets } from '../services/rate-limits.js';
import { purgeExpiredRecords } from '../services/retention.js';
import { runOpsDigest } from '../services/ops-digest.js';
import type { AppEnvironment } from '../types.js';

export const internalRoutes = new Hono<AppEnvironment>();

/** Work budget per cron invocation; vercel.json allows 60 s per function. */
export const JOB_BUDGET_MS = 50_000;
/** Upper bound of jobs per invocation, far above the expected daily volume. */
const JOB_MAX_ITEMS = 500;

internalRoutes.get('/internal/jobs/account-deletions', async (context) => {
  requireInternalSecret(context.req.header('authorization'));
  const deadlineAt = Date.now() + JOB_BUDGET_MS;
  const deletions = await runAccountDeletionBatch(JOB_MAX_ITEMS, { deadlineAt });
  const rateLimitBucketsDeleted = await cleanupExpiredRateLimitBuckets();
  const purged = await purgeExpiredRecords();
  writeLog('info', 'account_deletions.completed', {
    claimed: deletions.claimed,
    completed: deletions.completed,
    failed: deletions.failed,
    drained: deletions.drained,
    rate_limit_buckets_deleted: rateLimitBucketsDeleted,
    purged_idempotency_records: purged.idempotencyRecords,
    purged_operations_requests: purged.operationsRequests,
    purged_usage_reservations: purged.usageReservations,
    purged_provider_events: purged.providerEvents,
    purged_legacy_sessions: purged.legacySessions,
    purged_legacy_verifications: purged.legacyVerifications,
  });
  return context.json({ ...deletions, rateLimitBucketsDeleted, purged });
});

internalRoutes.get('/internal/jobs/referral-rewards', async (context) => {
  requireInternalSecret(context.req.header('authorization'));
  const rewards = await runReferralRewards(JOB_MAX_ITEMS, Date.now() + JOB_BUDGET_MS);
  writeLog('info', 'referral_rewards.completed', {
    attempted: rewards.attempted,
    processed: rewards.processed,
    drained: rewards.drained,
  });
  return context.json(rewards);
});

internalRoutes.get('/internal/jobs/ops-digest', async (context) => {
  requireInternalSecret(context.req.header('authorization'));
  return context.json(await runOpsDigest());
});

function requireInternalSecret(authorization: string | undefined): void {
  const expected = requireEnvironmentValue(getEnvironment().CRON_SECRET, 'CRON_SECRET');
  const provided = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (
    expectedBytes.length !== providedBytes.length ||
    !timingSafeEqual(expectedBytes, providedBytes)
  ) {
    throw new ApiError(401, 'invalid_internal_token', 'Invalid internal token');
  }
}
