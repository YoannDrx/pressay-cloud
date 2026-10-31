import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { SignJWT } from 'jose';
const sqlQuery = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import type { AdminUserDetail, AdminUsers } from '../src/contracts/operations-wire.ts';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'admin customer search and record on PostgreSQL',
  () => {
    const schema = `admin_customers_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let owner: string;
    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      sqlQuery.mockImplementation(
        async (sql: string, values: unknown[]) =>
          (await pool.query<Record<string, unknown>>(sql, values)).rows,
      );
      for (const file of (await readdir(new URL('../migrations', import.meta.url)))
        .filter((f) => f.endsWith('.sql'))
        .sort()) {
        await pool.query(
          await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
        );
      }
    });
    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE "user",pressay_account,operations_owner,operations_audit,provider_event CASCADE',
      );
      owner = await account('owner@example.com');
    });

    /** Account with an optional contact; entitlement rows are opt-in. */
    async function account(
      email: string | null,
      options: { entitlement?: boolean; subject?: string } = {},
    ) {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO pressay_account(id,auth_user_id) VALUES($1::uuid,$2::text)',
        [id, options.subject ?? id],
      );
      if (options.entitlement !== false)
        await pool.query('INSERT INTO entitlement(account_id) VALUES($1)', [id]);
      if (email)
        await pool.query(
          'INSERT INTO account_contact(account_id,email) VALUES($1,$2)',
          [id, email],
        );
      return id;
    }
    async function device(
      accountId: string,
      platform: 'macos' | 'windows',
      revoked = false,
    ) {
      const rows = await pool.query<{ id: string }>(
        `INSERT INTO pressay_device(account_id,device_identifier_hash,display_name,platform,app_variant,app_version,revoked_at)
        VALUES($1,$2,'Work computer',$3,'direct','1.4.0',$4) RETURNING id`,
        [accountId, randomBytes(32), platform, revoked ? new Date() : null],
      );
      return String(rows.rows[0]?.id);
    }
    async function subscription(
      accountId: string,
      provider: 'stripe' | 'app_store',
      id: string,
      environment: 'Production' | 'Sandbox' = 'Production',
    ) {
      await pool.query(
        `INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,trial_ends_at,current_period_ends_at,cancel_at_period_end,grace_ends_at,apple_environment,provider_event_occurred_at)
        VALUES($1,$2,$3,'prod_test','past_due','year',now()-interval '20 days',now()+interval '300 days',true,now()+interval '3 days',$4,now())`,
        [accountId, provider, id, environment],
      );
      await pool.query('SELECT recompute_pressay_entitlement($1)', [accountId]);
    }
    async function api(path: string): Promise<{ response: Response; data: unknown }> {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_INTERNAL_JWT_SECRET =
        'local-operations-test-key-32-characters';
      process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
      process.env.PRESSAY_CAMPAIGN_SECRET = 'local-campaign-test-key-32-characters';
      process.env.RATE_LIMIT_HMAC_SECRET = 'local-rate-limit-test-key-32-characters';
      process.env.PRESSAY_OPERATIONS_OWNER_EMAILS = 'owner@example.com';
      clearEnvironmentCacheForTests();
      const token = await new SignJWT({
        email: 'owner@example.com',
        email_verified: true,
        token_use: 'pressay_web_proxy',
        sid: 'session',
        pressay_step_up_method: 'totp',
        pressay_step_up_at: Math.floor(Date.now() / 1000),
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(owner)
        .setIssuer('https://press-say.app/internal')
        .setAudience('pressay-api')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(new TextEncoder().encode(process.env.PRESSAY_INTERNAL_JWT_SECRET));
      const response = await app.request(`/v1/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { response, data: (await response.json()) as unknown };
    }
    async function search(params: Record<string, string>) {
      const { response, data } = await api(
        `admin/users?${new URLSearchParams(params)}`,
      );
      expect(response.status, JSON.stringify(data)).toBe(200);
      return data as AdminUsers;
    }
    const ids = (result: AdminUsers) => result.users.map((user) => user.id).sort();

    it('treats % and _ literally and lists accounts without an entitlement row', async () => {
      const underscore = await account('a_b@example.test');
      await account('axb@example.test');
      const bare = await account('bare@example.test', { entitlement: false });
      expect(ids(await search({ search: 'a_b' }))).toEqual([underscore]);
      expect((await search({ search: '%' })).users).toEqual([]);
      const found = await search({ search: 'bare@' });
      expect(found.searchKind).toBe('text');
      expect(found.users).toMatchObject([
        { id: bare, plan: 'free', entitlement_source: 'none', sandbox: false },
      ]);
    });

    it('finds an account by Stripe, Apple, device, account and identity identifiers', async () => {
      const stripe = await account('stripe@example.test');
      const apple = await account('apple@example.test');
      const sandbox = await account('review@example.test');
      const external = await account('external@example.test', {
        subject: 'BetterAuthSubject0123456789abcd',
      });
      await pool.query(
        "INSERT INTO billing_customer(account_id,stripe_customer_id) VALUES($1,'cus_Test123')",
        [stripe],
      );
      await subscription(stripe, 'stripe', 'sub_Test123');
      await pool.query(
        "INSERT INTO billing_customer(account_id,app_store_original_transaction_id) VALUES($1,'2000000123456789')",
        [apple],
      );
      await subscription(sandbox, 'app_store', 'sandbox/2000000999999999', 'Sandbox');
      const pc = await device(apple, 'windows');

      expect(await search({ search: 'cus_Test123' })).toMatchObject({
        searchKind: 'stripe_customer',
        users: [{ id: stripe }],
      });
      expect(ids(await search({ search: 'sub_Test123' }))).toEqual([stripe]);
      expect(ids(await search({ search: '2000000123456789' }))).toEqual([apple]);
      expect(ids(await search({ search: '2000000999999999' }))).toEqual([sandbox]);
      expect(await search({ search: pc })).toMatchObject({
        searchKind: 'uuid',
        users: [{ id: apple, windows_device_count: 1, macos_device_count: 0 }],
      });
      expect(ids(await search({ search: ` ${stripe} ` }))).toEqual([stripe]);
      expect(ids(await search({ search: 'BetterAuthSubject0123456789abcd' }))).toEqual([
        external,
      ]);
      // An identifier never falls back to an email substring match.
      expect((await search({ search: 'cus_Unknown' })).users).toEqual([]);
    });

    it('reports Apple Sandbox access apart from paid Pro and counts devices per platform', async () => {
      const paid = await account('paid@example.test');
      const review = await account('review@example.test');
      await subscription(paid, 'stripe', 'sub_Paid');
      await subscription(review, 'app_store', 'sandbox/2000000555555555', 'Sandbox');
      await device(paid, 'macos');
      await device(paid, 'macos');
      await device(paid, 'windows');
      await device(paid, 'windows', true);

      expect(ids(await search({ plan: 'pro' }))).toEqual([paid]);
      expect(await search({ plan: 'sandbox' })).toMatchObject({
        users: [{ id: review, plan: 'sandbox', sandbox: true }],
      });
      expect((await search({ search: 'paid@' })).users[0]).toMatchObject({
        plan: 'pro',
        entitlement_source: 'stripe',
        macos_device_count: 2,
        windows_device_count: 1,
        active_device_count: 3,
      });
      const overview = (await api('admin/overview')).data as {
        plans: { plan: string; count: number }[];
      };
      expect(overview.plans).toEqual(
        expect.arrayContaining([
          { plan: 'pro', count: 1 },
          { plan: 'sandbox', count: 1 },
        ]),
      );
    });

    it('filters deleted accounts', async () => {
      const gone = await account(null);
      await pool.query(
        "UPDATE pressay_account SET status='deleted',deletion_requested_at=now() WHERE id=$1",
        [gone],
      );
      expect(ids(await search({ status: 'deleted' }))).toEqual([gone]);
      expect(ids(await search({ status: 'active' }))).toEqual([owner]);
    });

    it('returns the complete support record and audits the read', async () => {
      const customer = await account('customer@example.test', {
        subject: 'customer-subject',
      });
      await pool.query(
        "INSERT INTO billing_customer(account_id,stripe_customer_id) VALUES($1,'cus_Detail')",
        [customer],
      );
      await subscription(customer, 'stripe', 'sub_Detail');
      await device(customer, 'macos');
      await device(customer, 'windows', true);
      for (let month = 0; month < 14; month++)
        await pool.query(
          `INSERT INTO usage_period(account_id,period_start,transcription_seconds_used,transformations_used)
          VALUES($1,(date_trunc('month',now())-make_interval(months=>$2))::date,$3,1)`,
          [customer, month, 60 * (month + 1)],
        );
      await pool.query(
        "INSERT INTO provider_event(provider,provider_event_id,payload_sha256,event_type,provider_occurred_at) VALUES('stripe','evt_refund',$1,'charge.refunded',now())",
        [randomBytes(32)],
      );
      await pool.query(
        "INSERT INTO billing_financial_event(provider,provider_event_id,provider_object_id,account_id,provider_subscription_id,kind,status,amount_minor,currency,full_reversal,provider_occurred_at) VALUES('stripe','evt_refund','re_1',$1,'sub_Detail','refund','succeeded',6900,'eur',true,now())",
        [customer],
      );
      await pool.query(
        "INSERT INTO billing_legal_acceptance(account_id,checkout_idempotency_key,terms_version,immediate_performance_consent) VALUES($1,'checkout-key-0123456789','2026-10-01',true)",
        [customer],
      );
      const grant = await pool.query<{ id: string }>(
        "INSERT INTO access_grant(account_id,source,ends_at) VALUES($1,'invitation',now()+interval '30 days') RETURNING id",
        [customer],
      );
      const grantId = String(grant.rows[0]?.id);
      await pool.query(
        "INSERT INTO operations_audit(actor_id,action,target_id,reason,request_id) VALUES($1,'grant.revoked',$2,'Duplicate gift','req-1')",
        [owner, grantId],
      );
      await pool.query("SELECT request_pressay_account_deletion('customer-subject')");

      const { response, data: body } = await api(
        `admin/users/${customer}?include=identity`,
      );
      expect(response.status, JSON.stringify(body)).toBe(200);
      const data = body as AdminUserDetail;
      expect(data.account).toMatchObject({
        accountId: customer,
        authUserId: 'customer-subject',
        email: 'customer@example.test',
        status: 'deleting',
      });
      expect(data.account.deletionRequestedAt).toBeTruthy();
      expect(data.billingCustomer).toEqual({
        stripeCustomerId: 'cus_Detail',
        appStoreOriginalTransactionId: null,
        stripeMode: 'test',
      });
      // Deletion revokes devices immediately: both are listed with their platform.
      expect(data.devices.map((d) => d.platform).sort()).toEqual(['macos', 'windows']);
      expect(data.devices.every((d) => d.revokedAt)).toBe(true);
      expect(data.subscriptions[0]).toMatchObject({
        provider: 'stripe',
        provider_subscription_id: 'sub_Detail',
        status: 'past_due',
        cancel_at_period_end: true,
        apple_environment: 'Production',
      });
      expect(data.subscriptions[0]?.trial_ends_at).toBeTruthy();
      expect(data.subscriptions[0]?.grace_ends_at).toBeTruthy();
      expect(data.financialEvents).toMatchObject([
        { kind: 'refund', amount_minor: 6900, currency: 'eur', full_reversal: true },
      ]);
      expect(data.legalAcceptances).toMatchObject([{ terms_version: '2026-10-01' }]);
      expect(data.deletion).toMatchObject({ state: 'queued' });
      expect(data.usageHistory).toHaveLength(12);
      expect(data.usage.transcription.usedSeconds).toBe(60);
      expect(data.audit).toMatchObject([
        { action: 'grant.revoked', target_id: grantId },
      ]);
      expect(data.auditReads?.count).toBe(2);
      const reads = await pool.query<{ action: string }>(
        "SELECT action FROM operations_audit WHERE reason='personal_data_read' AND target_id=$1 ORDER BY id",
        [customer],
      );
      expect(reads.rows.map((r) => r.action)).toEqual([
        'admin.user.read',
        'admin.user.identity.read',
      ]);
    });

    it('returns 404 for an unknown account', async () => {
      const { response } = await api(`admin/users/${randomUUID()}`);
      expect(response.status).toBe(404);
    });
  },
);
