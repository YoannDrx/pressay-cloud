import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearEnvironmentCacheForTests } from '../src/env.ts';

const query = vi.hoisted(() => vi.fn());
const listSubscriptions = vi.hoisted(() => vi.fn());
const listCheckoutSessions = vi.hoisted(() => vi.fn());
const createCheckoutSession = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query }) }));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({
    customers: { update: vi.fn().mockResolvedValue({}) },
    subscriptions: { list: listSubscriptions },
    checkout: {
      sessions: {
        create: createCheckoutSession,
        list: listCheckoutSessions,
        expire: vi.fn(),
      },
    },
  }),
}));
import { createCheckout } from '../src/services/billing.ts';

function checkout(key: string) {
  return createCheckout(
    'lease-user',
    'lease@example.test',
    'month',
    key,
    '2026-08-10',
    true,
  );
}

// Run against an isolated local database, never a deployed database.
describe.skipIf(!process.env.APPLE_TEST_DATABASE_URL)(
  'Checkout lease PostgreSQL integration',
  () => {
    const client = new pg.Client({
      connectionString: process.env.APPLE_TEST_DATABASE_URL,
    });
    const schema = `checkout_lease_test_${randomUUID().replaceAll('-', '')}`;
    const accountId = randomUUID();
    const leaseCount = async () =>
      (
        await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM billing_checkout_lease',
        )
      ).rows[0]?.count;

    beforeAll(async () => {
      await client.connect();
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      for (const name of [
        '0001_auth.sql',
        '0002_control_plane.sql',
        '0009_unified_entitlements.sql',
        '0011_legal_acceptance.sql',
        '0016_app_review_sandbox.sql',
        '0022_billing_checkout_lease.sql',
        '0022_billing_checkout_lease.sql',
      ]) {
        await client.query(
          await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'),
        );
      }
      query.mockImplementation(
        async (sql: string, values: unknown[]) =>
          (await client.query<Record<string, unknown>>(sql, values)).rows,
      );
      await client.query(
        'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)',
        ['lease-user', 'lease@example.test'],
      );
      await client.query(
        'INSERT INTO pressay_account (id, auth_user_id) VALUES ($1, $2)',
        [accountId, 'lease-user'],
      );
      await client.query('INSERT INTO entitlement (account_id) VALUES ($1)', [
        accountId,
      ]);
      await client.query(
        "INSERT INTO billing_customer (account_id, stripe_customer_id) VALUES ($1, 'cus_lease')",
        [accountId],
      );
      await client.query(
        "INSERT INTO billing_product (id, provider, provider_product_id, provider_price_id, tier, billing_interval, active) VALUES ('stripe_pro', 'stripe', 'prod_lease', 'price_lease', 'pro', 'month', true)",
      );
    });

    beforeEach(async () => {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_DEPLOYMENT_ENV = 'production';
      process.env.ENTITLEMENT_SIGNING_KEY_ID = 'pressay-entitlement-production-2026-01';
      process.env.STRIPE_COMMERCIAL_LAUNCH_ENABLED = 'true';
      process.env.STRIPE_SECRET_KEY = 'rk_live_placeholder';
      process.env.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_pressay';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_placeholder';
      process.env.STRIPE_PRODUCT_PRO = 'prod_lease';
      process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_lease';
      process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_lease_annual';
      clearEnvironmentCacheForTests();
      listSubscriptions.mockReset().mockResolvedValue({ data: [] });
      listCheckoutSessions.mockReset().mockResolvedValue({ data: [] });
      createCheckoutSession
        .mockReset()
        .mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/lease' });
      await client.query('DELETE FROM billing_checkout_lease');
    });

    afterAll(async () => {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    });

    it('lets one of two concurrent requests through and releases the lease', async () => {
      let releaseStripe: () => void = () => undefined;
      listSubscriptions.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStripe = () => resolve({ data: [] });
          }),
      );
      const first = checkout('checkout-lease-key-tab-1');
      await vi.waitFor(() => expect(listSubscriptions).toHaveBeenCalledOnce());
      expect(await leaseCount()).toBe(1);

      await expect(checkout('checkout-lease-key-tab-2')).rejects.toMatchObject({
        status: 409,
        code: 'checkout_in_progress',
      });
      releaseStripe();
      await expect(first).resolves.toBe('https://checkout.stripe.com/c/pay/lease');
      expect(createCheckoutSession).toHaveBeenCalledOnce();
      expect(await leaseCount()).toBe(0);
    });

    it('takes over a lease abandoned by a request that never released it', async () => {
      await client.query(
        "INSERT INTO billing_checkout_lease (account_id, lease_id, expires_at) VALUES ($1, $2, now() - interval '1 second')",
        [accountId, randomUUID()],
      );
      await expect(checkout('checkout-lease-key-retry')).resolves.toBe(
        'https://checkout.stripe.com/c/pay/lease',
      );
      expect(await leaseCount()).toBe(0);
    });

    it('keeps a live lease held by another request', async () => {
      const held = randomUUID();
      await client.query(
        "INSERT INTO billing_checkout_lease (account_id, lease_id, expires_at) VALUES ($1, $2, now() + interval '60 seconds')",
        [accountId, held],
      );
      await expect(checkout('checkout-lease-key-blocked')).rejects.toMatchObject({
        code: 'checkout_in_progress',
      });
      expect(
        (await client.query('SELECT lease_id FROM billing_checkout_lease')).rows,
      ).toEqual([{ lease_id: held }]);
    });
  },
);
