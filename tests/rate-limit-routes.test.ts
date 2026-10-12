import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const createCheckout = vi.hoisted(() => vi.fn());

vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query }) }));
vi.mock('../src/services/billing.ts', () => ({
  createCheckout,
  createBillingPortal: vi.fn(),
  getBillingStatus: vi.fn(),
  processStripeWebhook: vi.fn(),
}));

import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { bearer, configureTestIdentity } from './helpers/identity.ts';

/** Emulates consume_pressay_rate_limit: a fixed window counter per hashed key. */
function emulateRateLimitFunction(): void {
  const counters = new Map<string, number>();
  query.mockImplementation((sql: string, values: unknown[]) => {
    if (!sql.includes('consume_pressay_rate_limit')) return Promise.resolve([]);
    const [scope, hash, limit] = values as [string, string, number];
    const key = `${scope}:${hash}`;
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);
    if (count > limit) return Promise.reject(new Error('rate_limit_exceeded'));
    return Promise.resolve([{}]);
  });
}

const checkoutBody = JSON.stringify({
  interval: 'month',
  acceptedTerms: true,
  immediatePerformanceConsent: true,
  termsVersion: '2026-01-01',
});

describe('route rate limits', () => {
  beforeEach(() => {
    query.mockReset();
    createCheckout.mockReset();
    createCheckout.mockResolvedValue('https://checkout.stripe.com/c/pay/test');
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.RATE_LIMIT_HMAC_SECRET = 'rate-limit-test-secret-at-least-32-chars';
    clearEnvironmentCacheForTests();
    configureTestIdentity();
    emulateRateLimitFunction();
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_HMAC_SECRET;
    delete process.env.PRESSAY_REFERRALS_ENABLED;
    clearEnvironmentCacheForTests();
  });

  it('returns 429 with Retry-After on the 11th checkout in a minute', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.request('/v1/billing/checkout', {
        method: 'POST',
        headers: {
          ...(await bearer('checkout-user')),
          'content-type': 'application/json',
          'idempotency-key': `checkout-idempotency-${attempt.toString().padStart(4, '0')}`,
        },
        body: checkoutBody,
      });
      statuses.push(response.status);
      if (attempt === 10) {
        expect(response.headers.get('retry-after')).toBe('60');
        expect(await response.json()).toMatchObject({
          error: { code: 'rate_limit_exceeded' },
        });
      }
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(createCheckout).toHaveBeenCalledTimes(10);
    // Identifiers are hashed before they reach the database.
    expect(JSON.stringify(query.mock.calls)).not.toContain('checkout-user');
  });

  it('limits public referral code lookups per client IP', async () => {
    process.env.PRESSAY_REFERRALS_ENABLED = 'true';
    clearEnvironmentCacheForTests();
    let last = 0;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const response = await app.request('/v1/referral-codes/ABCDEF', {
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      last = response.status;
    }
    expect(last).toBe(429);
    const other = await app.request('/v1/referral-codes/ABCDEF', {
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(other.status).toBe(200);
  });
});
