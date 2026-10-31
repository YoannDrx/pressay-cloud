import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { SignJWT } from 'jose';
const sqlQuery = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import type { AdminMetrics } from '../src/contracts/operations-wire.ts';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'admin commercial metrics on PostgreSQL',
  () => {
    const schema = `admin_metrics_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const run = async (sql: string, values: unknown[] = []) =>
      (await pool.query<Record<string, unknown>>(sql, values)).rows;
    let owner: string;
    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      sqlQuery.mockImplementation(async (sql: string, values: unknown[]) =>
        run(sql, values),
      );
      for (const file of (await readdir(new URL('../migrations', import.meta.url)))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await pool.query(
          await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
        );
      // Replaying 0026 changes nothing.
      await pool.query(
        await readFile(
          new URL('../migrations/0026_subscription_price.sql', import.meta.url),
          'utf8',
        ),
      );
    });
    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    beforeEach(async () => {
      await run(
        'TRUNCATE "user",pressay_account,operations_owner,operations_audit,provider_event,download_event CASCADE',
      );
      owner = await account('owner@example.com', '40 days');
    });

    async function account(email: string | null, age = '0 days') {
      const id = randomUUID();
      await run(
        'INSERT INTO pressay_account(id,auth_user_id,created_at) VALUES($1::uuid,$1::text,now()-$2::interval)',
        [id, age],
      );
      await run('INSERT INTO entitlement(account_id) VALUES($1)', [id]);
      if (email)
        await run('INSERT INTO account_contact(account_id,email) VALUES($1,$2)', [
          id,
          email,
        ]);
      return id;
    }
    async function subscription(
      accountId: string,
      provider: 'stripe' | 'app_store',
      interval: 'month' | 'year',
      status: string,
      amount: number | null,
      environment: 'Production' | 'Sandbox' = 'Production',
      currency: string | null = amount === null ? null : 'eur',
    ) {
      await run(
        `INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,current_period_ends_at,cancel_at_period_end,apple_environment,provider_event_occurred_at,amount_minor,currency)
        VALUES($1,$2,$3,'prod',$4,$5,now()+interval '20 days',false,$6,now(),$7,$8)`,
        [
          accountId,
          provider,
          `${environment === 'Sandbox' ? 'sandbox/' : ''}${randomUUID()}`,
          status,
          interval,
          environment,
          amount,
          currency,
        ],
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test responses
    async function api<T>(path: string): Promise<{ status: number; data: T }> {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_INTERNAL_JWT_SECRET =
        'local-operations-test-key-32-characters';
      process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
      process.env.PRESSAY_OPERATIONS_OWNER_EMAILS = 'owner@example.com';
      process.env.PRESSAY_APP_STORE_ANNUAL_AMOUNT_MINOR = '7200';
      clearEnvironmentCacheForTests();
      const token = await new SignJWT({
        email: 'owner@example.com',
        email_verified: true,
        token_use: 'pressay_web_proxy',
        // Administrators have an Authenticator app.
        pressay_two_factor: true,
        sid: 'session',
        // Aggregates only: no step-up needed.
        pressay_step_up_at: 0,
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
      return { status: response.status, data: (await response.json()) as T };
    }

    it('reports subscribers, MRR/ARR for Stripe and Apple, signups, activity, grants, cash and downloads', async () => {
      const monthly = await account('monthly@example.test', '2 days');
      const yearly = await account(null, '2 days');
      const trial = await account(null);
      const apple = await account(null, '5 days');
      const reviewer = await account(null, '45 days');
      await subscription(monthly, 'stripe', 'month', 'active', 799);
      // Stored before 0026: the catalogue applies and it is counted as estimated.
      await subscription(yearly, 'stripe', 'year', 'past_due', null);
      await subscription(trial, 'stripe', 'month', 'trialing', 799);
      await subscription(apple, 'app_store', 'year', 'active', 7999);
      await subscription(apple, 'app_store', 'month', 'grace', null);
      await subscription(reviewer, 'app_store', 'month', 'active', 799, 'Sandbox');
      await subscription(reviewer, 'stripe', 'month', 'canceled', 799);
      await run(
        `INSERT INTO pressay_device(account_id,device_identifier_hash,display_name,app_variant,app_version,last_seen_at,revoked_at) VALUES
        ($1,$4,'Mac','direct','1.0',now()-interval '1 day',NULL),
        ($2,$5,'PC','direct','1.0',now()-interval '10 days',NULL),
        ($3,$6,'Old','direct','1.0',now()-interval '1 day',now())`,
        [monthly, yearly, trial, randomBytes(32), randomBytes(32), randomBytes(32)],
      );
      await run(
        `INSERT INTO access_grant(account_id,source,starts_at,ends_at) VALUES
        ($1,'support',now(),now()+interval '5 days'),($2,'invitation',now(),now()+interval '5 days'),
        ($2,'referral',now()-interval '9 days',now()-interval '1 day')`,
        [monthly, yearly],
      );
      for (const [id, kind, amount] of [
        ['evt_paid_1', 'invoice_paid', 799],
        ['evt_paid_2', 'invoice_paid', 6900],
        ['evt_refund', 'refund', 799],
        ['evt_failed', 'invoice_failed', 799],
      ] as const) {
        await run(
          `INSERT INTO provider_event(provider,provider_event_id,payload_sha256,event_type,provider_occurred_at,state,processed_at)
          VALUES('stripe',$1,decode(repeat('00',32),'hex'),'x',now(),'applied',now())`,
          [id],
        );
        await run(
          `INSERT INTO billing_financial_event(provider,provider_event_id,provider_object_id,account_id,kind,status,amount_minor,currency,provider_occurred_at)
          VALUES('stripe',$1,$1,$2,$3,'ok',$4,'eur',now())`,
          [id, monthly, kind, amount],
        );
      }
      await run(
        `INSERT INTO download_event(id,platform,asset_type,app_version,source) VALUES
        (gen_random_uuid(),'macos','dmg','1.4.0','site'),(gen_random_uuid(),'macos','dmg','1.4.0','site'),
        (gen_random_uuid(),'windows','msi','1.4.0','site')`,
      );
      await run(
        `INSERT INTO download_event(id,platform,asset_type,app_version,source,created_at) VALUES
        (gen_random_uuid(),'macos','dmg','1.3.0','site',now()-interval '20 days'),
        (gen_random_uuid(),'macos','dmg','1.2.0','site',now()-interval '40 days')`,
      );

      const { status, data } = await api<AdminMetrics>('admin/metrics');
      expect(status).toBe(200);
      expect(data.subscribers).toEqual([
        {
          provider: 'app_store',
          billing_interval: 'month',
          status: 'active',
          environment: 'Sandbox',
          count: 1,
        },
        {
          provider: 'app_store',
          billing_interval: 'month',
          status: 'grace',
          environment: 'Production',
          count: 1,
        },
        {
          provider: 'app_store',
          billing_interval: 'year',
          status: 'active',
          environment: 'Production',
          count: 1,
        },
        {
          provider: 'stripe',
          billing_interval: 'month',
          status: 'active',
          environment: 'Production',
          count: 1,
        },
        {
          provider: 'stripe',
          billing_interval: 'month',
          status: 'trialing',
          environment: 'Production',
          count: 1,
        },
        {
          provider: 'stripe',
          billing_interval: 'year',
          status: 'past_due',
          environment: 'Production',
          count: 1,
        },
      ]);
      // Stripe: 799 + 6900/12 (catalogue). Apple: 7999/12 + 799 (catalogue month).
      expect(data.mrr).toEqual([
        {
          provider: 'app_store',
          currency: 'eur',
          mrr_minor: Math.round(7999 / 12 + 799),
          arr_minor: Math.round(7999 / 12 + 799) * 12,
          subscriptions: 2,
          estimated_subscriptions: 1,
        },
        {
          provider: 'stripe',
          currency: 'eur',
          mrr_minor: 799 + 575,
          arr_minor: (799 + 575) * 12,
          subscriptions: 2,
          estimated_subscriptions: 1,
        },
      ]);
      expect(data.signups).toHaveLength(30);
      expect(data.signups.reduce((sum, day) => sum + day.count, 0)).toBe(4);
      expect(data.signups.at(-1)?.day).toBe(new Date().toISOString().slice(0, 10));
      expect(data.activeAccounts).toEqual({ active_7d: 1, active_30d: 2 });
      expect(data.grants).toEqual([
        { source: 'invitation', count: 1 },
        { source: 'support', count: 1 },
      ]);
      expect(data.collectedThisMonth).toEqual([
        { currency: 'eur', paid_minor: 7699, refunded_minor: 799, invoices: 2 },
      ]);
      expect(data.downloads).toEqual([
        { platform: 'macos', app_version: '1.4.0', last_7d: 2, last_30d: 2 },
        { platform: 'macos', app_version: '1.3.0', last_7d: 0, last_30d: 1 },
        { platform: 'windows', app_version: '1.4.0', last_7d: 1, last_30d: 1 },
      ]);
      expect(JSON.stringify(data)).not.toContain('@');
      expect(JSON.stringify(data)).not.toContain(monthly);
    });
  },
);
