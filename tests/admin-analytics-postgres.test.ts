import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { SignJWT } from 'jose';
const sqlQuery = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import type { AdminAdvancedMetrics } from '../src/contracts/operations-wire.ts';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'subscription history, churn, cohorts, trials and CSV exports on PostgreSQL',
  () => {
    const schema = `admin_analytics_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const run = async (sql: string, values: unknown[] = []) =>
      (await pool.query<Record<string, unknown>>(sql, values)).rows;
    const migration = async (file: string) =>
      readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    let owner: string;
    let preexisting: string;

    /** `days` days (and `hours` hours) into the UTC month `offset` months ago. */
    function at(offset: number, days: number, hours = 12): Date {
      const now = new Date();
      return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1 + days, hours),
      );
    }
    function month(offset: number): string {
      return at(offset, 0).toISOString().slice(0, 7);
    }

    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      sqlQuery.mockImplementation(async (sql: string, values: unknown[]) =>
        run(sql, values),
      );
      const files = (await readdir(new URL('../migrations', import.meta.url)))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files.filter((f) => f < '0028'))
        await pool.query(await migration(file));
      // A subscription written before 0028: the migration backfills its status.
      preexisting = await account(null, at(8, 1));
      await run(
        `INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,apple_environment,provider_event_occurred_at)
        VALUES($1,'stripe','sub_preexisting','prod','canceled','month','Production',$2)`,
        [preexisting, at(7, 3)],
      );
      for (const file of files.filter((f) => f >= '0028'))
        await pool.query(await migration(file));
      // Replaying 0028 changes nothing.
      await pool.query(await migration('0028_subscription_transitions.sql'));
    });
    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    beforeEach(async () => {
      await run(
        `DELETE FROM billing_subscription WHERE provider_subscription_id<>'sub_preexisting'`,
      );
      await run(
        `TRUNCATE operations_owner,operations_audit,download_event,billing_financial_event,provider_event,rate_limit_bucket CASCADE`,
      );
      await run('DELETE FROM pressay_account WHERE id<>$1', [preexisting]);
      owner = await account('owner@example.com', at(10, 1));
    });

    async function account(email: string | null, createdAt: Date) {
      const id = randomUUID();
      await run(
        'INSERT INTO pressay_account(id,auth_user_id,created_at) VALUES($1::uuid,$1::text,$2)',
        [id, createdAt],
      );
      await run('INSERT INTO entitlement(account_id) VALUES($1)', [id]);
      if (email)
        await run('INSERT INTO account_contact(account_id,email) VALUES($1,$2)', [
          id,
          email,
        ]);
      return id;
    }
    /** Creates a subscription, then applies each later status at its date. */
    async function history(
      accountId: string,
      steps: [string, Date][],
      provider: 'stripe' | 'app_store' = 'stripe',
      environment: 'Production' | 'Sandbox' = 'Production',
    ) {
      const id = `${environment === 'Sandbox' ? 'sandbox/' : ''}${randomUUID()}`;
      const [first, ...rest] = steps;
      if (!first) throw new Error('A history needs a first status');
      await run(
        `INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,apple_environment,provider_event_occurred_at)
        VALUES($1,$2,$3,'prod',$4,'month',$5,$6)`,
        [accountId, provider, id, first[0], environment, first[1]],
      );
      for (const [status, date] of rest)
        await run(
          'UPDATE billing_subscription SET status=$2,provider_event_occurred_at=$3 WHERE provider_subscription_id=$1',
          [id, status, date],
        );
      return id;
    }
    async function token(stepUp: boolean) {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_INTERNAL_JWT_SECRET =
        'local-operations-test-key-32-characters';
      process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
      process.env.RATE_LIMIT_HMAC_SECRET = 'local-rate-limit-test-key-32-characters';
      process.env.PRESSAY_OPERATIONS_OWNER_EMAILS = 'owner@example.com';
      clearEnvironmentCacheForTests();
      return new SignJWT({
        email: 'owner@example.com',
        email_verified: true,
        token_use: 'pressay_web_proxy',
        // Administrators have an Authenticator app.
        pressay_two_factor: true,
        sid: 'session',
        pressay_step_up_method: 'totp',
        pressay_step_up_at: stepUp ? Math.floor(Date.now() / 1000) : 0,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(owner)
        .setIssuer('https://press-say.app/internal')
        .setAudience('pressay-api')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(new TextEncoder().encode(process.env.PRESSAY_INTERNAL_JWT_SECRET));
    }
    async function get(path: string, stepUp = true) {
      return app.request(`/v1/${path}`, {
        headers: { authorization: `Bearer ${await token(stepUp)}` },
      });
    }

    /** Production story over the last four months, plus Sandbox noise. */
    async function seed() {
      // M-3: trial, converted after 8 days, canceled in M-1 (churn).
      const a = await account(null, at(3, 1));
      await history(a, [
        ['trialing', at(3, 2)],
        ['active', at(3, 10)],
        ['canceled', at(1, 5)],
      ]);
      // M-2: pays at once (App Store), a failed payment in M-1 recovers.
      const b = await account(null, at(2, 1));
      await history(
        b,
        [
          ['active', at(2, 2)],
          ['past_due', at(1, 3)],
          ['active', at(1, 4)],
        ],
        'app_store',
      );
      // M-2: Sandbox purchase (App Review), never counted.
      const e = await account(null, at(2, 1));
      await history(e, [['active', at(2, 3)]], 'app_store', 'Sandbox');
      // M-2: paid a Stripe invoice, no subscription history (paid before 0028).
      const f = await account(null, at(2, 1));
      await run(
        `INSERT INTO provider_event(provider,provider_event_id,payload_sha256,event_type,provider_occurred_at,state,processed_at)
        VALUES('stripe','evt_paid',decode(repeat('00',32),'hex'),'invoice.paid',$1,'applied',$1)`,
        [at(2, 5)],
      );
      await run(
        `INSERT INTO billing_financial_event(provider,provider_event_id,provider_object_id,account_id,kind,status,amount_minor,currency,provider_occurred_at)
        VALUES('stripe','evt_paid','in_1',$1,'invoice_paid','paid',799,'eur',$2)`,
        [f, at(2, 5)],
      );
      // M-1: trial that ends without paying.
      const c = await account(null, at(1, 1));
      await history(c, [
        ['trialing', at(1, 2)],
        ['canceled', at(1, 9)],
      ]);
      // This month: a trial still running.
      const d = await account(null, new Date(Date.now() - 120_000));
      await history(d, [['trialing', new Date(Date.now() - 60_000)]]);
    }

    it('records each status change once, backfills earlier subscriptions and ignores no-op updates', async () => {
      const backfilled = await run(
        `SELECT from_status,to_status,backfilled,occurred_at FROM billing_subscription_transition t
        JOIN billing_subscription s ON s.id=t.subscription_id WHERE s.provider_subscription_id='sub_preexisting'`,
      );
      expect(backfilled).toEqual([
        {
          from_status: null,
          to_status: 'canceled',
          backfilled: true,
          occurred_at: at(7, 3),
        },
      ]);
      const id = await history(owner, [
        ['trialing', at(1, 1)],
        ['active', at(1, 2)],
      ]);
      // Same status again (a later event, or an ON CONFLICT upsert): no row.
      await run(
        "UPDATE billing_subscription SET status='active',cancel_at_period_end=true WHERE provider_subscription_id=$1",
        [id],
      );
      await run(
        `INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,provider_event_occurred_at)
        VALUES($1,'stripe',$2,'prod','past_due','month',$3)
        ON CONFLICT (provider,provider_subscription_id) DO UPDATE SET status=EXCLUDED.status,provider_event_occurred_at=EXCLUDED.provider_event_occurred_at`,
        [owner, id, at(0, 0)],
      );
      expect(
        await run(
          `SELECT t.from_status,t.to_status,t.provider,t.environment,t.billing_interval,t.backfilled FROM billing_subscription_transition t
          JOIN billing_subscription s ON s.id=t.subscription_id WHERE s.provider_subscription_id=$1 ORDER BY t.id`,
          [id],
        ),
      ).toEqual([
        {
          from_status: null,
          to_status: 'trialing',
          provider: 'stripe',
          environment: 'Production',
          billing_interval: 'month',
          backfilled: false,
        },
        expect.objectContaining({ from_status: 'trialing', to_status: 'active' }),
        expect.objectContaining({ from_status: 'active', to_status: 'past_due' }),
      ]);
      // Erasing the subscription (account deletion) erases its history.
      await run('DELETE FROM billing_subscription WHERE provider_subscription_id=$1', [
        id,
      ]);
      expect(
        await run(
          'SELECT count(*)::int AS n FROM billing_subscription_transition WHERE account_id=$1',
          [owner],
        ),
      ).toEqual([{ n: 0 }]);
    });

    it('reports churn, conversion by cohort and trials, Production only', async () => {
      await seed();
      const response = await get('admin/metrics/advanced?months=4&days=30', false);
      expect(response.status).toBe(200);
      const data = (await response.json()) as AdminAdvancedMetrics;
      expect(data.months).toBe(4);
      expect(data.historyStartedAt).not.toBeNull();
      expect(data.churn).toEqual([
        { month: month(3), paying_start: 0, new_paying: 1, churned: 0 },
        { month: month(2), paying_start: 1, new_paying: 1, churned: 0 },
        { month: month(1), paying_start: 2, new_paying: 0, churned: 1 },
        { month: month(0), paying_start: 1, new_paying: 0, churned: 0 },
      ]);
      expect(data.cohorts).toEqual([
        { month: month(3), signups: 1, converted: 1, converted_30d: 1, trials: 1 },
        // B (App Store), the Sandbox reviewer and F (Stripe invoice only).
        { month: month(2), signups: 3, converted: 2, converted_30d: 2, trials: 0 },
        { month: month(1), signups: 1, converted: 0, converted_30d: 0, trials: 1 },
        { month: month(0), signups: 1, converted: 0, converted_30d: 0, trials: 1 },
      ]);
      expect(data.trials).toEqual([
        { month: month(3), started: 1, converted: 1, ended: 0, running: 0 },
        { month: month(2), started: 0, converted: 0, ended: 0, running: 0 },
        { month: month(1), started: 1, converted: 0, ended: 1, running: 0 },
        { month: month(0), started: 1, converted: 0, ended: 0, running: 1 },
      ]);
      expect(JSON.stringify(data)).not.toContain('@');
    });

    it('breaks downloads down by platform, version, source and campaign', async () => {
      await run(
        `INSERT INTO download_event(id,platform,asset_type,app_version,source,campaign,created_at) VALUES
        (gen_random_uuid(),'macos','dmg','1.4.0','site',NULL,now()),
        (gen_random_uuid(),'macos','dmg','1.4.0','newsletter','=HYPERLINK("x")',now()),
        (gen_random_uuid(),'windows','msi','1.4.0','site','launch',now()),
        (gen_random_uuid(),'macos','dmg','1.3.0','site',NULL,now()-interval '40 days')`,
      );
      const response = await get('admin/metrics/advanced?days=30', false);
      const data = (await response.json()) as AdminAdvancedMetrics;
      expect(data.months).toBe(12);
      expect(data.churn).toHaveLength(12);
      expect(data.downloads).toEqual({
        platforms: [
          { platform: 'macos', count: 2 },
          { platform: 'windows', count: 1 },
        ],
        versions: [
          { platform: 'macos', app_version: '1.4.0', count: 2 },
          { platform: 'windows', app_version: '1.4.0', count: 1 },
        ],
        sources: [
          { source: 'site', count: 2 },
          { source: 'newsletter', count: 1 },
        ],
        campaigns: [
          { campaign: '=HYPERLINK("x")', count: 1 },
          { campaign: 'launch', count: 1 },
        ],
      });
    });

    it('refuses invalid metric filters', async () => {
      for (const query of ['months=0', 'months=25', 'days=400', 'months=x', 'extra=1'])
        expect((await get(`admin/metrics/advanced?${query}`, false)).status).toBe(422);
    });

    it('exports aggregate CSV after step-up, neutralises formulas and audits each export', async () => {
      await seed();
      await run(
        `INSERT INTO download_event(id,platform,asset_type,app_version,source,campaign) VALUES
        (gen_random_uuid(),'macos','dmg','1.4.0','@evil','=HYPERLINK("http://x")'),
        (gen_random_uuid(),'windows','exe','1.4.0','site',NULL)`,
      );
      const refused = await get('admin/export/churn.csv?months=4', false);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: 'step_up_required' },
      });

      const churn = await get('admin/export/churn.csv?months=4');
      expect(churn.status).toBe(200);
      expect(churn.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(churn.headers.get('content-disposition')).toMatch(
        /^attachment; filename="pressay-churn-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(churn.headers.get('cache-control')).toBe('private, no-store');
      expect(await churn.text()).toBe(
        [
          'month,paying_start,new_paying,churned,churn_rate',
          `"${month(3)}","0","1","0",""`,
          `"${month(2)}","1","1","0","0.0000"`,
          `"${month(1)}","2","0","1","0.5000"`,
          `"${month(0)}","1","0","0","0.0000"`,
          '',
        ].join('\r\n'),
      );

      const cohorts = await (await get('admin/export/cohorts.csv?months=2')).text();
      expect(cohorts.split('\r\n')[0]).toBe(
        'month,signups,converted,conversion_rate,converted_30d,conversion_rate_30d,trials',
      );
      expect(cohorts.split('\r\n')[1]).toBe(
        `"${month(1)}","1","0","0.0000","0","0.0000","1"`,
      );
      const trials = await (await get('admin/export/trials.csv?months=4')).text();
      expect(trials.split('\r\n')[1]).toBe(`"${month(3)}","1","1","0","0","1.0000"`);

      const downloads = await (await get('admin/export/downloads.csv?days=7')).text();
      expect(downloads).toContain(`"'@evil","'=HYPERLINK(""http://x"")","1"`);
      expect(downloads).not.toMatch(/(^|,)"[=+\-@]/m);
      const signups = await (await get('admin/export/signups.csv?days=3')).text();
      expect(signups.trim().split('\r\n')).toHaveLength(4);

      for (const [path, status] of [
        ['admin/export/accounts.csv', 404],
        ['admin/export/churn.json', 404],
        ['admin/export/..%2Fchurn.csv', 404],
        ['admin/export/churn.csv?days=7', 422],
        ['admin/export/downloads.csv?months=3', 422],
        ['admin/export/churn.csv?months=99', 422],
        ['admin/export/signups.csv?days=0', 422],
      ] as const)
        expect((await get(path)).status, path).toBe(status);

      const ledger = await run(
        `SELECT actor_id,action,target_id,reason,result,details FROM operations_audit
        WHERE action='admin.export' ORDER BY id`,
      );
      expect(ledger.map((row) => row.target_id)).toEqual([
        'export/churn',
        'export/cohorts',
        'export/trials',
        'export/downloads',
        'export/signups',
      ]);
      expect(ledger[0]).toEqual({
        actor_id: owner,
        action: 'admin.export',
        target_id: 'export/churn',
        reason: 'data_export',
        result: 'succeeded',
        details: { dataset: 'churn', rows: 4, months: 4 },
      });
      expect(ledger[3]?.details).toEqual({ dataset: 'downloads', rows: 2, days: 7 });
      expect(JSON.stringify(ledger)).not.toContain('evil');
    });

    it('limits exports to ten a minute per administrator', async () => {
      for (let index = 0; index < 10; index += 1)
        expect((await get('admin/export/signups.csv?days=1')).status).toBe(200);
      expect((await get('admin/export/signups.csv?days=1')).status).toBe(429);
    });
  },
);
