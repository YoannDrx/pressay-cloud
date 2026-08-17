import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import { getEnvironment, requireEnvironmentValue } from '../env.ts';
import { ApiError } from '../lib/errors.ts';
import { runAccountDeletionBatch } from '../services/account-deletion.ts';
import { cleanupExpiredRateLimitBuckets } from '../services/rate-limits.ts';
import type { AppEnvironment } from '../types.ts';

export const internalRoutes = new Hono<AppEnvironment>();

internalRoutes.get('/internal/jobs/account-deletions', async (context) => {
  requireInternalSecret(context.req.header('authorization'));
  const deletions = await runAccountDeletionBatch(10);
  const rateLimitBucketsDeleted = await cleanupExpiredRateLimitBuckets();
  return context.json({ ...deletions, rateLimitBucketsDeleted });
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
