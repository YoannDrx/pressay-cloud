import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));

import { clearEnvironmentCacheForTests } from '../src/env.ts';
import {
  assertCloudProcessingEnabled,
  cleanupExpiredRateLimitBuckets,
  enforceCloudRateLimits,
} from '../src/services/rate-limits.ts';

describe('Cloud rate limits and kill switch', () => {
  beforeEach(() => {
    query.mockReset();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.RATE_LIMIT_HMAC_SECRET =
      'rate-limit-test-secret-at-least-32-characters';
    process.env.PRESSAY_CLOUD_PROCESSING_ENABLED = 'true';
    clearEnvironmentCacheForTests();
  });

  it('applies independent account, device and IP buckets without storing identifiers', async () => {
    query.mockResolvedValue([]);
    await enforceCloudRateLimits(
      'auth-user-sensitive',
      'device-sensitive',
      '203.0.113.10',
    );
    expect(query).toHaveBeenCalledTimes(3);
    const calls = JSON.stringify(query.mock.calls);
    expect(calls).not.toContain('auth-user-sensitive');
    expect(calls).not.toContain('device-sensitive');
    expect(calls).not.toContain('203.0.113.10');
  });

  it('maps database exhaustion to a stable 429', async () => {
    query.mockRejectedValueOnce(new Error('rate_limit_exceeded'));
    await expect(
      enforceCloudRateLimits('auth-user', 'device', '203.0.113.11'),
    ).rejects.toMatchObject({ status: 429, code: 'rate_limit_exceeded' });
  });

  it('blocks Cloud processing immediately when the server switch is off', () => {
    process.env.PRESSAY_CLOUD_PROCESSING_ENABLED = 'false';
    clearEnvironmentCacheForTests();
    expect(() => assertCloudProcessingEnabled()).toThrow(
      expect.objectContaining({ code: 'cloud_processing_disabled' }),
    );
  });

  it('purges only expired opaque rate-limit buckets', async () => {
    query.mockResolvedValue([{ deleted_count: 7 }]);
    await expect(cleanupExpiredRateLimitBuckets()).resolves.toBe(7);
    expect(query.mock.calls[0]?.[0]).toContain('WHERE expires_at < now()');
  });
});
