import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { SignJWT } from 'jose';
const sqlQuery = vi.hoisted(() => vi.fn());
const retrieveEvent = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({ events: { retrieve: retrieveEvent } }),
}));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { runOpsDigest } from '../src/services/ops-digest.ts';
import type {
  AdminAlerts,
  AdminFinancialEvents,
  AdminProviderEvents,
  AdminUserDetail,
} from '../src/contracts/operations-wire.ts';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'admin billing visibility on PostgreSQL',
  () => {
    const schema = `admin_billing_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const migration = async (file: string) =>
      readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    let owner: string;
    let backfill: { provider_event_id: string; linked: boolean }[] = [];
    const run = async (sql: string, values: unknown[] = []) =>
      (await pool.query<Record<string, unknown>>(sql, values)).rows;

    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      sqlQuery.mockImplementation(async (sql: string, values: unknown[]) =>
        run(sql, values),
      );
      const files = (await readdir(new URL('../migrations', import.meta.url)))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files.filter((f) => f < '0025'))
        await pool.query(await migration(file));
      // An event recorded before 0025 with its ledger row, and one without.
      const account = randomUUID();
      await run(
        'INSERT INTO pressay_account(id,auth_user_id) VALUES($1::uuid,$1::text)',
        [account],
      );
      await run(
        `INSERT INTO provider_event(provider,provider_event_id,payload_sha256,event_type,provider_occurred_at,state,processed_at)
        VALUES('stripe','evt_before_ledger',decode(repeat('00',32),'hex'),'invoice.paid',now(),'applied',now()),
        ('stripe','evt_before_plain',decode(repeat('00',32),'hex'),'customer.created',now(),'ignored',now())`,
      );
      await run(
        `INSERT INTO billing_financial_event(provider,provider_event_id,provider_object_id,account_id,kind,status,amount_minor,currency,provider_occurred_at)
        VALUES('stripe','evt_before_ledger','in_before',$1,'invoice_paid','paid',799,'eur',now())`,
        [account],
      );
      for (const file of files.filter((f) => f >= '0025'))
        await pool.query(await migration(file));
      await pool.query(await migration('0025_provider_event_account.sql'));
      backfill = (await run(
        `SELECT provider_event_id,account_id IS NOT NULL AS linked FROM provider_event
        WHERE provider_event_id LIKE 'evt_before%' ORDER BY 1`,
      )) as typeof backfill;
    });
    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    beforeEach(async () => {
      vi.clearAllMocks();
      await run(
        'TRUNCATE "user",pressay_account,operations_owner,operations_audit,operations_request,provider_event,rate_limit_bucket CASCADE',
      );
      owner = await account('owner@example.com');
    });

    async function account(email: string | null) {
      const id = randomUUID();
      await run(
        'INSERT INTO pressay_account(id,auth_user_id) VALUES($1::uuid,$1::text)',
        [id],
      );
      await run('INSERT INTO entitlement(account_id) VALUES($1)', [id]);
      if (email)
        await run('INSERT INTO account_contact(account_id,email) VALUES($1,$2)', [
          id,
          email,
        ]);
      return id;
    }
    async function providerEvent(
      id: string,
      state: 'applied' | 'failed' | 'ignored',
      accountId: string | null = null,
      receivedAgo = '1 hour',
    ) {
      await run(
        `INSERT INTO provider_event(provider,provider_event_id,payload_sha256,event_type,provider_occurred_at,state,error_code,processed_at,received_at,account_id)
        VALUES('stripe',$1,decode(repeat('ab',32),'hex'),'charge.refunded',now(),$2,$3,now(),now()-$4::interval,$5)`,
        [
          id,
          state,
          state === 'failed' ? 'stripe_api_error' : null,
          receivedAgo,
          accountId,
        ],
      );
    }
    async function financial(
      id: string,
      accountId: string,
      kind: string,
      status: string,
      objectId: string,
      ago = '1 hour',
    ) {
      await providerEvent(id, 'applied', accountId);
      await run(
        `INSERT INTO billing_financial_event(provider,provider_event_id,provider_object_id,account_id,kind,status,amount_minor,currency,provider_occurred_at)
        VALUES('stripe',$1,$2,$3,$4,$5,6900,'eur',now()-$6::interval)`,
        [id, objectId, accountId, kind, status, ago],
      );
    }
    async function subscription(accountId: string, id: string, status: string) {
      await run(
        `INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,current_period_ends_at,cancel_at_period_end,apple_environment,provider_event_occurred_at)
        VALUES($1,'stripe',$2,'prod_x',$3,'month',now()+interval '20 days',false,'Production',now())`,
        [accountId, id, status],
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test responses
    async function api<T>(
      path: string,
      init: { body?: unknown; stepUp?: boolean } = {},
    ): Promise<{ status: number; data: T }> {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_INTERNAL_JWT_SECRET =
        'local-operations-test-key-32-characters';
      process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
      process.env.RATE_LIMIT_HMAC_SECRET = 'local-rate-limit-test-key-32-characters';
      process.env.PRESSAY_OPERATIONS_OWNER_EMAILS = 'owner@example.com';
      clearEnvironmentCacheForTests();
      const token = await new SignJWT({
        email: 'owner@example.com',
        email_verified: true,
        token_use: 'pressay_web_proxy',
        // Administrators have an Authenticator app.
        pressay_two_factor: true,
        sid: 'session',
        pressay_step_up_method: 'totp',
        pressay_step_up_at: init.stepUp === false ? 0 : Math.floor(Date.now() / 1000),
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(owner)
        .setIssuer('https://press-say.app/internal')
        .setAudience('pressay-api')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(new TextEncoder().encode(process.env.PRESSAY_INTERNAL_JWT_SECRET));
      const response = await app.request(`/v1/${path}`, {
        method: init.body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { status: response.status, data: (await response.json()) as T };
    }
    const replayBody = () => ({
      idempotencyKey: randomUUID(),
      reason: 'Webhook timeout',
    });

    it('links earlier ledger events to their account', () => {
      expect(backfill).toEqual([
        { provider_event_id: 'evt_before_ledger', linked: true },
        { provider_event_id: 'evt_before_plain', linked: false },
      ]);
    });

    it('lists refunds, open disputes and failed payments with the customer, under step-up', async () => {
      const customer = await account('customer@example.test');
      await financial('evt_refund', customer, 'refund', 'succeeded_full', 're_1');
      await financial(
        'evt_dispute_open',
        customer,
        'dispute',
        'needs_response',
        'dp_open',
      );
      await financial(
        'evt_dispute_a',
        customer,
        'dispute',
        'needs_response',
        'dp_won',
        '2 days',
      );
      await financial('evt_dispute_b', customer, 'dispute', 'won', 'dp_won');
      await financial('evt_failed', customer, 'invoice_failed', 'open', 'in_failed');
      expect(
        (await api('admin/billing/financial-events', { stepUp: false })).status,
      ).toBe(403);
      const refunds = await api<AdminFinancialEvents>(
        'admin/billing/financial-events?kind=refund',
      );
      expect(refunds.data.events).toMatchObject([
        {
          provider_object_id: 're_1',
          account_id: customer,
          email: 'customer@example.test',
        },
      ]);
      const open = await api<AdminFinancialEvents>(
        'admin/billing/financial-events?kind=dispute&open=true',
      );
      expect(open.data.events.map((event) => event.provider_object_id)).toEqual([
        'dp_open',
      ]);
      const failed = await api<AdminFinancialEvents>(
        'admin/billing/financial-events?kind=invoice_failed',
      );
      expect(failed.data.events).toHaveLength(1);
      expect(
        await run(
          "SELECT action FROM operations_audit WHERE reason='personal_data_read'",
        ),
      ).toContainEqual({ action: 'admin.billing.financial.read' });
      for (let index = 0; index < 52; index += 1)
        await financial(
          `evt_page_${index}`,
          customer,
          'invoice_paid',
          'paid',
          `in_${index}`,
        );
      const first = await api<AdminFinancialEvents>(
        'admin/billing/financial-events?kind=invoice_paid',
      );
      expect(first.data.events).toHaveLength(50);
      const second = await api<AdminFinancialEvents>(
        `admin/billing/financial-events?kind=invoice_paid&cursor=${encodeURIComponent(first.data.nextCursor ?? '')}`,
      );
      expect(second.data.events).toHaveLength(2);
      expect(second.data.nextCursor).toBeNull();
      expect((await api('admin/billing/financial-events?cursor=nonsense')).status).toBe(
        422,
      );
    });

    it('counts billing alerts and filters failed webhooks', async () => {
      const customer = await account('customer@example.test');
      const twice = await account(null);
      await providerEvent('evt_failed_recent', 'failed', customer);
      await providerEvent('evt_failed_old', 'failed', null, '3 days');
      await providerEvent('evt_ok', 'applied', customer);
      await financial(
        'evt_dispute',
        customer,
        'dispute',
        'warning_needs_response',
        'dp_1',
      );
      await subscription(customer, 'sub_unpaid', 'past_due');
      await subscription(twice, 'sub_one', 'active');
      await subscription(twice, 'sub_two', 'trialing');
      const alerts = await api<AdminAlerts>('admin/alerts', { stepUp: false });
      expect(alerts.status).toBe(200);
      expect(alerts.data).toMatchObject({
        failed_webhooks: 2,
        failed_webhooks_24h: 1,
        open_disputes: 1,
        unpaid_subscriptions: 1,
        duplicate_subscriptions: 1,
      });
      const failed = await api<AdminProviderEvents>(
        'admin/billing/events?state=failed',
      );
      expect(
        failed.data.events.map((event) => [event.provider_event_id, event.account_id]),
      ).toEqual([
        ['evt_failed_recent', customer],
        ['evt_failed_old', null],
      ]);
      const detail = await api<AdminUserDetail>(`admin/users/${customer}`);
      expect(
        detail.data.providerEvents?.map((event) => event.provider_event_id),
      ).toContain('evt_failed_recent');
    });

    it('replays a failed Stripe event once through the webhook projection and audits it', async () => {
      const customer = await account('customer@example.test');
      await run(
        "INSERT INTO billing_customer(account_id,stripe_customer_id) VALUES($1,'cus_replay')",
        [customer],
      );
      await providerEvent('evt_replay', 'failed');
      retrieveEvent.mockResolvedValue({
        id: 'evt_replay',
        type: 'charge.refunded',
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: {
          object: {
            object: 'charge',
            id: 'ch_replay',
            customer: 'cus_replay',
            amount: 799,
            amount_refunded: 200,
            currency: 'eur',
            created: Math.floor(Date.now() / 1000) - 3600,
          },
        },
      });
      const replay = await api<Record<string, unknown>>(
        'admin/billing/events/stripe/evt_replay/replay',
        { body: replayBody() },
      );
      expect(replay.status, JSON.stringify(replay.data)).toBe(200);
      expect(replay.data).toMatchObject({ state: 'applied', accountId: customer });
      expect(
        await run(
          "SELECT state,account_id FROM provider_event WHERE provider_event_id='evt_replay'",
        ),
      ).toEqual([{ state: 'applied', account_id: customer }]);
      expect(
        await run(
          "SELECT kind,amount_minor FROM billing_financial_event WHERE provider_event_id='evt_replay'",
        ),
      ).toEqual([{ kind: 'refund', amount_minor: '200' }]);
      expect(
        await api('admin/billing/events/stripe/evt_replay/replay', {
          body: replayBody(),
        }),
      ).toMatchObject({ status: 409, data: { error: { code: 'event_not_failed' } } });
      expect(
        await run(
          "SELECT action,result,target_id,target_account_id FROM operations_audit WHERE action LIKE 'billing.event.replay%' ORDER BY id",
        ),
      ).toEqual([
        {
          action: 'billing.event.replay.requested',
          result: 'requested',
          target_id: 'stripe/evt_replay',
          target_account_id: null,
        },
        {
          action: 'billing.event.replay',
          result: 'succeeded',
          target_id: 'stripe/evt_replay',
          target_account_id: customer,
        },
        {
          action: 'billing.event.replay.requested',
          result: 'requested',
          target_id: 'stripe/evt_replay',
          target_account_id: customer,
        },
        {
          action: 'billing.event.replay',
          result: 'failed',
          target_id: 'stripe/evt_replay',
          target_account_id: customer,
        },
      ]);
    });

    it('refuses replays Stripe cannot serve, from the other mode, or from Apple', async () => {
      await providerEvent('evt_gone', 'failed');
      retrieveEvent.mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'resource_missing' }),
      );
      expect(
        await api('admin/billing/events/stripe/evt_gone/replay', {
          body: replayBody(),
        }),
      ).toMatchObject({
        status: 409,
        data: { error: { code: 'stripe_event_unavailable' } },
      });
      retrieveEvent.mockResolvedValueOnce({ id: 'evt_gone', livemode: true });
      expect(
        await api('admin/billing/events/stripe/evt_gone/replay', {
          body: replayBody(),
        }),
      ).toMatchObject({
        status: 409,
        data: { error: { code: 'stripe_livemode_mismatch' } },
      });
      expect(
        await api('admin/billing/events/apple/evt_gone/replay', { body: replayBody() }),
      ).toMatchObject({ status: 422, data: { error: { code: 'replay_unsupported' } } });
      expect(
        (
          await api('admin/billing/events/stripe/evt_unknown/replay', {
            body: replayBody(),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await api('admin/billing/events/stripe/evt_gone/replay', {
            body: replayBody(),
            stepUp: false,
          })
        ).status,
      ).toBe(403);
      expect(
        await run(
          "SELECT state FROM provider_event WHERE provider_event_id='evt_gone'",
        ),
      ).toEqual([{ state: 'failed' }]);
    });

    it('logs the daily digest and posts it only when a webhook is configured', async () => {
      const customer = await account('customer@example.test');
      await providerEvent('evt_failed_digest', 'failed', customer);
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      delete process.env.OPS_ALERT_WEBHOOK_URL;
      clearEnvironmentCacheForTests();
      const fetcher = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
      const quiet = await runOpsDigest(fetcher);
      expect(quiet).toMatchObject({
        attention: true,
        delivery: 'not_configured',
        counters: { failed_webhooks: 1 },
      });
      expect(fetcher).not.toHaveBeenCalled();
      process.env.OPS_ALERT_WEBHOOK_URL = 'https://hooks.example.test/ops';
      clearEnvironmentCacheForTests();
      try {
        const posted = await runOpsDigest(fetcher);
        expect(posted.delivery).toBe(204);
        expect(fetcher).toHaveBeenCalledWith(
          'https://hooks.example.test/ops',
          expect.objectContaining({ method: 'POST' }),
        );
        const [, init] = fetcher.mock.calls[0] as unknown as [string, { body: string }];
        const body = init.body;
        expect(JSON.parse(body)).toMatchObject({
          service: 'pressay-cloud',
          attention: true,
          counters: { failed_webhooks: 1 },
        });
        expect(body).not.toContain(customer);
        expect(body).not.toContain('@');
      } finally {
        delete process.env.OPS_ALERT_WEBHOOK_URL;
        clearEnvironmentCacheForTests();
      }
    });
  },
);
