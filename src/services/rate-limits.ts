import { createHmac } from 'node:crypto';

import { z } from 'zod';

import { getSql } from '../db/client.js';
import { getEnvironment, requireEnvironmentValue } from '../env.js';
import { ApiError } from '../lib/errors.js';

const cleanupResultSchema = z.object({
  deleted_count: z.coerce.number().int().nonnegative(),
});

function rateLimitHash(scope: string, identifier: string): string {
  return createHmac(
    'sha256',
    requireEnvironmentValue(
      getEnvironment().RATE_LIMIT_HMAC_SECRET,
      'RATE_LIMIT_HMAC_SECRET',
    ),
  )
    .update(scope)
    .update('\0')
    .update(identifier)
    .digest('hex');
}

async function consume(
  scope: string,
  identifier: string,
  limit: number,
): Promise<void> {
  try {
    await getSql().query(
      "SELECT consume_pressay_rate_limit($1, decode($2, 'hex'), $3, 60)",
      [scope, rateLimitHash(scope, identifier), limit],
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('rate_limit_exceeded')) {
      throw new ApiError(429, 'rate_limit_exceeded', 'Too many requests');
    }
    throw error;
  }
}

export async function enforceCloudRateLimits(
  authUserId: string,
  deviceId: string,
  ipAddress: string,
): Promise<void> {
  const environment = getEnvironment();
  await consume(
    'cloud_account',
    authUserId,
    environment.PRESSAY_CLOUD_ACCOUNT_RATE_PER_MINUTE,
  );
  await consume(
    'cloud_device',
    `${authUserId}:${deviceId}`,
    environment.PRESSAY_CLOUD_DEVICE_RATE_PER_MINUTE,
  );
  await consume('cloud_ip', ipAddress, environment.PRESSAY_CLOUD_IP_RATE_PER_MINUTE);
}

export function assertCloudProcessingEnabled(): void {
  if (!getEnvironment().PRESSAY_CLOUD_PROCESSING_ENABLED) {
    throw new ApiError(
      503,
      'cloud_processing_disabled',
      'Cloud processing is temporarily unavailable',
    );
  }
}

export async function cleanupExpiredRateLimitBuckets(): Promise<number> {
  const rows = await getSql().query(
    `WITH deleted AS (
      DELETE FROM rate_limit_bucket
      WHERE expires_at < now()
      RETURNING 1
    )
    SELECT count(*)::integer AS deleted_count FROM deleted`,
    [],
  );
  const result = cleanupResultSchema.safeParse(rows[0]);
  return result.success ? result.data.deleted_count : 0;
}
