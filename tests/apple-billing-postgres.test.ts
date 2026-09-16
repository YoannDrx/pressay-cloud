import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import Stripe from 'stripe';
import { processStripeWebhook } from '../src/services/billing.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { clearStripeForTests } from '../src/billing/stripe-client.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Environment, Status } from '@apple/app-store-server-library';

const query = vi.hoisted(() => vi.fn());
const verifyAppleTransaction = vi.hoisted(() => vi.fn());
const getVerifiedAppleSubscriptionStatuses = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query }) }));
vi.mock('../src/billing/apple-client.ts', () => ({
  verifyAppleTransaction,
  getVerifiedAppleSubscriptionStatuses,
  verifyAppleNotification: vi.fn(),
  verifyAppleNotificationTransaction: vi.fn(),
}));
import { restoreAppStorePurchase } from '../src/services/apple-billing.ts';

// Run against an isolated local database, never a deployed database.
describe.skipIf(!process.env.APPLE_TEST_DATABASE_URL)(
  'Apple billing PostgreSQL integration',
  () => {
    const client = new pg.Client({
      connectionString: process.env.APPLE_TEST_DATABASE_URL,
    });
    const schema = `apple_test_${randomUUID().replaceAll('-', '')}`;
    const accountId = randomUUID();
    const productId = 'app.pressay.desktop.mas.pro.monthly';
    const now = Date.now();
    beforeAll(async () => {
      await client.connect();
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      for (const name of [
        '0001_auth.sql',
        '0002_control_plane.sql',
        '0009_unified_entitlements.sql',
        '0013_billing_financial_events.sql',
        '0016_app_review_sandbox.sql',
        '0017_operations.sql',
      ]) {
        await client.query(
          await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'),
        );
      }
      query.mockImplementation(
        async (sql: string, values: unknown[]) =>
          (await client.query<Record<string, unknown>>(sql, values)).rows,
      );
    });
    beforeEach(async () => {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_DEPLOYMENT_ENV = 'development';
      process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_postgres_test';
      clearEnvironmentCacheForTests();
      clearStripeForTests();
      await client.query('TRUNCATE "user", billing_product, provider_event CASCADE');
      await client.query(
        'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)',
        ['test-user', 'test@example.test'],
      );
      await client.query(
        'INSERT INTO pressay_account (id, auth_user_id) VALUES ($1, $2)',
        [accountId, 'test-user'],
      );
      await client.query('INSERT INTO entitlement (account_id) VALUES ($1)', [
        accountId,
      ]);
      await client.query(
        "INSERT INTO billing_product (id, provider, provider_product_id, provider_price_id, tier, billing_interval, active) VALUES ('pro', 'app_store', $1, $1, 'pro', 'month', true)",
        [productId],
      );
    });
    afterAll(async () => {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
    });
    async function restore(
      environment: Environment.PRODUCTION | Environment.SANDBOX,
      status = Status.ACTIVE,
      expiresDate = now + 600_000,
      originalTransactionId = '12345',
    ) {
      const transaction = {
        transactionId: '67890',
        originalTransactionId,
        productId,
        purchaseDate: now,
        expiresDate,
        signedDate: Date.now(),
        appAccountToken: accountId,
      };
      verifyAppleTransaction.mockResolvedValue({ environment, transaction });
      getVerifiedAppleSubscriptionStatuses.mockResolvedValue([{ transaction, status }]);
      return restoreAppStorePurchase(
        'test-user',
        'test.signed.transaction',
        randomUUID(),
      );
    }
    async function entitlement() {
      const row = (
        await client.query<{
          tier: string;
          valid_until: Date | null;
          offline_grace_until: Date | null;
        }>(
          'SELECT tier, valid_until, offline_grace_until FROM entitlement WHERE account_id = $1',
          [accountId],
        )
      ).rows[0];
      if (!row) throw new Error('Expected account entitlement');
      return row;
    }
    it('grants verified Sandbox access without paid grace or production customer linkage', async () => {
      await restore(Environment.SANDBOX);
      expect(await entitlement()).toEqual({
        tier: 'pro',
        valid_until: new Date(now + 600_000),
        offline_grace_until: new Date(now + 600_000),
      });
      expect((await client.query('SELECT * FROM billing_customer')).rowCount).toBe(0);
      expect(
        (
          await client.query(
            'SELECT provider_subscription_id, apple_environment FROM billing_subscription',
          )
        ).rows,
      ).toEqual([
        { provider_subscription_id: 'sandbox/12345', apple_environment: 'Sandbox' },
      ]);
    });
    it('keeps a real purchase independent from a Sandbox transaction with the same Apple ID', async () => {
      await restore(Environment.SANDBOX, Status.ACTIVE, now + 3_600_000);
      await restore(Environment.PRODUCTION, Status.ACTIVE, now + 1_800_000);
      expect((await entitlement()).valid_until).toEqual(new Date(now + 1_800_000));
      expect((await entitlement()).offline_grace_until).toEqual(
        new Date(now + 1_800_000 + 72 * 3_600_000),
      );
      await restore(Environment.SANDBOX, Status.REVOKED);
      expect((await entitlement()).tier).toBe('pro');
      expect((await client.query('SELECT * FROM billing_subscription')).rowCount).toBe(
        2,
      );
      expect(
        (
          await client.query(
            'SELECT app_store_original_transaction_id FROM billing_customer',
          )
        ).rows[0],
      ).toEqual({ app_store_original_transaction_id: '12345' });
    });
    it('revokes test access after a verified refund', async () => {
      await restore(Environment.SANDBOX);
      await restore(Environment.SANDBOX, Status.REVOKED);
      expect((await entitlement()).tier).toBe('free');
    });
    it('does not grant access for expired test subscriptions', async () => {
      await restore(Environment.SANDBOX, Status.EXPIRED, now - 1);
      expect((await entitlement()).tier).toBe('free');
    });
    it('activates Stripe Pro, handles duplicate delivery and revokes on a full refund', async () => {
      await client.query(
        "INSERT INTO billing_customer (account_id, stripe_customer_id) VALUES ($1, 'cus_test')",
        [accountId],
      );
      await client.query(
        "INSERT INTO billing_product (id, provider, provider_product_id, provider_price_id, tier, billing_interval, active) VALUES ('stripe_pro', 'stripe', 'prod_test', 'price_test', 'pro', 'month', true)",
      );
      const stripe = new Stripe('sk_test_placeholder');
      async function deliver(event: object) {
        const payload = JSON.stringify(event);
        const signature = stripe.webhooks.generateTestHeaderString({
          payload,
          secret: 'whsec_local_postgres_test',
        });
        return processStripeWebhook(payload, signature);
      }
      const created = Math.floor(now / 1000);
      const event = {
        id: 'evt_subscription',
        object: 'event',
        created,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test',
            object: 'subscription',
            customer: 'cus_test',
            metadata: { pressay_account_id: accountId },
            status: 'active',
            trial_end: null,
            cancel_at_period_end: false,
            items: {
              data: [
                {
                  quantity: 1,
                  current_period_start: created,
                  current_period_end: created + 3600,
                  price: {
                    id: 'price_test',
                    product: 'prod_test',
                    recurring: { interval: 'month' },
                  },
                },
              ],
            },
          },
        },
      };
      expect(await deliver(event)).toEqual({ duplicateOrIgnored: false });
      expect((await entitlement()).tier).toBe('pro');
      expect(await deliver(event)).toEqual({ duplicateOrIgnored: true });
      expect(
        await deliver({
          id: 'evt_refund',
          object: 'event',
          created: created + 1,
          type: 'charge.refunded',
          data: {
            object: {
              id: 'ch_test',
              object: 'charge',
              customer: 'cus_test',
              amount: 799,
              amount_refunded: 799,
              currency: 'eur',
              created,
            },
          },
        }),
      ).toEqual({ duplicateOrIgnored: false });
      expect((await entitlement()).tier).toBe('free');
      expect(
        (
          await client.query(
            'SELECT state FROM provider_event ORDER BY provider_event_id',
          )
        ).rows,
      ).toEqual([{ state: 'applied' }, { state: 'applied' }]);
    });
  },
);
