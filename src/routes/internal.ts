import { timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';

import { getEnvironment, requireEnvironmentValue } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { runAccountDeletionBatch } from '../services/account-deletion.js';
import { cleanupExpiredRateLimitBuckets } from '../services/rate-limits.js';
import type { AppEnvironment } from '../types.js';

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
