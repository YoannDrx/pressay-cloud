import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import Stripe from 'stripe';
import { processStripeWebhook } from '../src/services/billing.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Environment, Status } from '@apple/app-store-server-library';

const query = vi.hoisted(() => vi.fn());
const verifyAppleTransaction = vi.hoisted(() => vi.fn());
const getVerifiedAppleSubscriptionStatuses = vi.hoisted(() => vi.fn());
const retrieveSubscription = vi.hoisted(() => vi.fn());
const cancelSubscription = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query }) }));
vi.mock('../src/billing/stripe-client.ts', async () => {
  const { default: StripeClient } = await import('stripe');
  const real = new StripeClient('sk_test_placeholder');
  return {
    getStripe: () => ({
      webhooks: real.webhooks,
      subscriptions: { retrieve: retrieveSubscription, cancel: cancelSubscription },
    }),
    clearStripeForTests: () => undefined,
  };
});
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
        '0019_billing_hardening.sql',
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
      retrieveSubscription.mockReset();
      cancelSubscription.mockReset();
      // Stripe no longer knows these local fixtures: project the event snapshot.
      retrieveSubscription.mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'resource_missing' }),
      );
      cancelSubscription.mockResolvedValue({ status: 'canceled' });
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
    it('marks Sandbox access so support can tell it apart from paid access', async () => {
      await restore(Environment.SANDBOX);
      expect(
        (
          await client.query<{ sandbox: boolean }>(
            'SELECT sandbox FROM entitlement WHERE account_id = $1',
            [accountId],
          )
        ).rows[0],
      ).toEqual({ sandbox: true });
    });
    it('links a tokenless purchase only after confirmation and never to a second account', async () => {
      const transaction = {
        transactionId: '67891',
        originalTransactionId: '55555',
        productId,
        purchaseDate: now,
        expiresDate: now + 600_000,
        signedDate: Date.now(),
      };
      verifyAppleTransaction.mockResolvedValue({
        environment: Environment.PRODUCTION,
        transaction,
      });
      getVerifiedAppleSubscriptionStatuses.mockResolvedValue([
        { transaction, status: Status.ACTIVE },
      ]);
      await expect(
        restoreAppStorePurchase('test-user', 'test.signed.transaction', randomUUID()),
      ).rejects.toMatchObject({ code: 'app_store_account_token_missing' });
      await expect(
        restoreAppStorePurchase('test-user', 'test.signed.transaction', randomUUID(), {
          linkToCurrentAccount: true,
        }),
      ).resolves.toEqual({ restored: true });
      expect((await entitlement()).tier).toBe('pro');

      const secondAccount = randomUUID();
      await client.query(
        'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)',
        ['second-user', 'second@example.test'],
      );
      await client.query(
        'INSERT INTO pressay_account (id, auth_user_id) VALUES ($1, $2)',
        [secondAccount, 'second-user'],
      );
      await client.query('INSERT INTO entitlement (account_id) VALUES ($1)', [
        secondAccount,
      ]);
      await expect(
        restoreAppStorePurchase(
          'second-user',
          'test.signed.transaction',
          randomUUID(),
          {
            linkToCurrentAccount: true,
          },
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'app_store_purchase_already_linked',
      });
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
      expect(cancelSubscription).toHaveBeenCalledWith(
        'sub_test',
        {},
        { idempotencyKey: 'pressay-reversal-cancel/sub_test' },
      );
      expect(
        (
          await client.query(
            'SELECT state FROM provider_event ORDER BY provider_event_id',
          )
        ).rows,
      ).toEqual([{ state: 'applied' }, { state: 'applied' }]);
    });
    async function stripeFixture() {
      await client.query(
        "INSERT INTO billing_customer (account_id, stripe_customer_id) VALUES ($1, 'cus_test')",
        [accountId],
      );
      await client.query(
        "INSERT INTO billing_product (id, provider, provider_product_id, provider_price_id, tier, billing_interval, active) VALUES ('stripe_pro', 'stripe', 'prod_test', 'price_test', 'pro', 'month', true)",
      );
      const stripe = new Stripe('sk_test_placeholder');
      return async (event: object) => {
        const payload = JSON.stringify(event);
        const signature = stripe.webhooks.generateTestHeaderString({
          payload,
          secret: 'whsec_local_postgres_test',
        });
        return processStripeWebhook(payload, signature);
      };
    }
    function subscriptionEvent(
      id: string,
      type: string,
      created: number,
      status: string,
      periodStart: number,
      periodEnd: number,
    ) {
      return {
        id,
        object: 'event',
        created,
        type,
        data: {
          object: {
            id: 'sub_test',
            object: 'subscription',
            customer: 'cus_test',
            metadata: { pressay_account_id: accountId },
            status,
            trial_end: null,
            cancel_at_period_end: false,
            items: {
              data: [
                {
                  quantity: 1,
                  current_period_start: periodStart,
                  current_period_end: periodEnd,
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
    }
    it('keeps an activation when the incomplete creation arrives later in the same second', async () => {
      const deliver = await stripeFixture();
      const created = Math.floor(now / 1000);
      await deliver(
        subscriptionEvent(
          'evt_updated',
          'customer.subscription.updated',
          created,
          'active',
          created,
          created + 3600,
        ),
      );
      await deliver(
        subscriptionEvent(
          'evt_created',
          'customer.subscription.created',
          created,
          'incomplete',
          created,
          created + 3600,
        ),
      );
      expect(
        (await client.query('SELECT status FROM billing_subscription')).rows,
      ).toEqual([{ status: 'active' }]);
      expect((await entitlement()).tier).toBe('pro');
    });
    it('ends past_due access after the grace window instead of the new period end', async () => {
      const deliver = await stripeFixture();
      const created = Math.floor(now / 1000);
      // Renewal failed ten days ago on a 30-day period: grace (7 days) is over.
      await deliver(
        subscriptionEvent(
          'evt_past_due_old',
          'customer.subscription.updated',
          created,
          'past_due',
          created - 10 * 86_400,
          created + 20 * 86_400,
        ),
      );
      expect((await entitlement()).tier).toBe('free');
      // A fresh failure keeps Pro only until period start + 7 days.
      await deliver(
        subscriptionEvent(
          'evt_past_due_new',
          'customer.subscription.updated',
          created + 1,
          'past_due',
          created - 2 * 86_400,
          created + 28 * 86_400,
        ),
      );
      const current = await entitlement();
      expect(current.tier).toBe('pro');
      expect(current.valid_until).toEqual(new Date((created + 5 * 86_400) * 1000));
    });
    it('reprocesses a delivery that previously failed', async () => {
      const deliver = await stripeFixture();
      const created = Math.floor(now / 1000);
      const event = subscriptionEvent(
        'evt_retry',
        'customer.subscription.updated',
        created,
        'active',
        created,
        created + 3600,
      );
      await client.query(
        "INSERT INTO provider_event (provider, provider_event_id, payload_sha256, event_type, provider_occurred_at, state, error_code, processed_at) VALUES ('stripe', 'evt_retry', decode(repeat('00', 32), 'hex'), 'customer.subscription.updated', now(), 'failed', 'database_40001', now())",
      );
      expect(await deliver(event)).toEqual({ duplicateOrIgnored: false });
      expect(
        (
          await client.query(
            "SELECT state, error_code FROM provider_event WHERE provider_event_id = 'evt_retry'",
          )
        ).rows,
      ).toEqual([{ state: 'applied', error_code: null }]);
      expect((await entitlement()).tier).toBe('pro');
    });
  },
);
