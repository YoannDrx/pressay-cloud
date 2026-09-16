import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { SignJWT } from 'jose';
const sqlQuery = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
vi.mock('../src/auth.ts', () => ({
  getAuth: () => ({ api: { getSession: () => Promise.resolve(null) } }),
}));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'operations ledger on PostgreSQL',
  () => {
    const schema = `operations_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let a: string, b: string, c: string;
    beforeAll(async () => {
      await pool.query<Record<string, unknown>>(`CREATE SCHEMA ${schema}`);
      sqlQuery.mockImplementation(
        async (sql: string, values: unknown[]) =>
          (await pool.query<Record<string, unknown>>(sql, values)).rows,
      );
      for (const file of (await readdir(new URL('../migrations', import.meta.url)))
        .filter((f) => f.endsWith('.sql'))
        .sort()) {
        await pool.query<Record<string, unknown>>(
          await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
        );
      }
    });
    afterAll(async () => {
      await pool.query<Record<string, unknown>>(
        `DROP SCHEMA IF EXISTS ${schema} CASCADE`,
      );
      await pool.end();
    });
    beforeEach(async () => {
      await pool.query<Record<string, unknown>>(
        'TRUNCATE "user",pressay_account,access_campaign,operations_owner,referral_reversal CASCADE',
      );
      const ids = [];
      for (let i = 0; i < 3; i++) {
        const id = randomUUID();
        ids.push(id);
        await pool.query<Record<string, unknown>>(
          'INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',
          [id, `${id}@example.test`],
        );
        await pool.query<Record<string, unknown>>(
          'INSERT INTO pressay_account(id,auth_user_id) VALUES($1::uuid,$1::text)',
          [id],
        );
        await pool.query<Record<string, unknown>>(
          'INSERT INTO entitlement(account_id) VALUES($1)',
          [id],
        );
      }
      [a, b, c] = ids as [string, string, string];
    });
    async function campaign(hash: string, days = 30, email: string | null = null) {
      const id = randomUUID();
      await pool.query<Record<string, unknown>>(
        "INSERT INTO access_campaign(id,request_key,kind,delivery,secret_hash,duration_days,restricted_email,max_redemptions,expires_at,status) VALUES($1,$1,'access_grant','code',$2,$3,$4,1,now()+interval '30 days','active')",
        [id, hash, days, email],
      );
      return id;
    }
    async function claim(account: string, hash: string, email = 'test@example.test') {
      return pool.query<Record<string, unknown>>(
        'SELECT claim_pressay_access($1,$2,$3)',
        [account, email, hash],
      );
    }
    async function entitlement(account: string) {
      return (
        (
          await pool.query<Record<string, unknown>>(
            'SELECT tier,source,valid_until FROM entitlement WHERE account_id=$1',
            [account],
          )
        ).rows[0] ?? {}
      );
    }
    async function attribute() {
      await pool.query<Record<string, unknown>>(
        "INSERT INTO referral_code(account_id,code) VALUES($1,'ABCDEF123456')",
        [a],
      );
      return pool.query<Record<string, unknown>>(
        "SELECT attribute_pressay_referral($1,'ABCDEF123456',now()) AS ok",
        [b],
      );
    }
    async function api(path: string, method = 'GET', body?: unknown) {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_INTERNAL_JWT_SECRET =
        'local-operations-test-key-32-characters';
      process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
      process.env.PRESSAY_CAMPAIGN_SECRET = 'local-campaign-test-key-32-characters';
      process.env.RATE_LIMIT_HMAC_SECRET = 'local-rate-limit-test-key-32-characters';
      process.env.PRESSAY_REFERRALS_ENABLED = 'true';
      clearEnvironmentCacheForTests();
      const token = await new SignJWT({
        email: 'yoann.andrieux@gmail.com',
        email_verified: true,
        token_use: 'pressay_web_proxy',
        sid: 'session',
        pressay_step_up_method: 'totp',
        pressay_step_up_at: Math.floor(Date.now() / 1000),
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(a)
        .setIssuer('https://press-say.app/internal')
        .setAudience('pressay-api')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(new TextEncoder().encode(process.env.PRESSAY_INTERNAL_JWT_SECRET));
      return app.request(`/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    }
    it('serves the actual administrative SQL and handles external identities without local contact metadata', async () => {
      for (const path of [
        'admin/overview',
        'admin/users',
        'admin/campaigns',
        'admin/referrals',
        'admin/billing/events',
        'admin/health',
        'admin/audit-log',
        `admin/users/${b}`,
        'referrals/me',
      ]) {
        const response = await api(path);
        expect(response.status, `${path}: ${await response.text()}`).toBe(200);
      }
    });
    it('creates, claims and audits an invitation through the authenticated API', async () => {
      const response = await api('admin/campaigns', 'POST', {
        kind: 'access_grant',
        idempotencyKey: randomUUID(),
        reason: 'Integration test',
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const created = (await response.json()) as { id: string; secret: string };
      expect(
        (await api('access/claim', 'POST', { secret: created.secret })).status,
      ).toBe(200);
      expect((await entitlement(a)).tier).toBe('pro');
      expect(
        (
          await api(`admin/campaigns/${created.id}/revoke`, 'POST', {
            reason: 'Test revocation',
          })
        ).status,
      ).toBe(200);
      expect((await entitlement(a)).tier).toBe('pro');
      expect(
        (await pool.query('SELECT * FROM operations_audit')).rowCount,
      ).toBeGreaterThan(2);
    });
    it('serializes simultaneous claims and consumes one code only once', async () => {
      await campaign('one');
      const results = await Promise.allSettled([claim(a, 'one'), claim(b, 'one')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (
          await pool.query<Record<string, unknown>>(
            'SELECT redemptions FROM access_campaign',
          )
        ).rows[0]?.redemptions,
      ).toBe(1);
      expect(
        (await pool.query<Record<string, unknown>>('SELECT * FROM access_grant'))
          .rowCount,
      ).toBe(1);
    });
    it('does not consume a second equal-duration code in concurrent claims', async () => {
      await campaign('first');
      await campaign('second');
      const results = await Promise.allSettled([claim(a, 'first'), claim(a, 'second')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await pool.query('SELECT * FROM access_grant')).rowCount).toBe(1);
    });
    it('rejects expired, revoked and email-restricted codes without consumption', async () => {
      const id = await campaign('limited', 30, 'allowed@example.test');
      await expect(claim(a, 'limited')).rejects.toThrow('access_unavailable');
      await pool.query<Record<string, unknown>>(
        "UPDATE access_campaign SET expires_at=now()-interval '1 day' WHERE id=$1",
        [id],
      );
      await expect(claim(a, 'limited', 'allowed@example.test')).rejects.toThrow(
        'access_unavailable',
      );
      await pool.query<Record<string, unknown>>(
        "UPDATE access_campaign SET expires_at=now()+interval '1 day',status='revoked' WHERE id=$1",
        [id],
      );
      await expect(claim(a, 'limited', 'allowed@example.test')).rejects.toThrow(
        'access_unavailable',
      );
      expect(
        (
          await pool.query<Record<string, unknown>>(
            'SELECT redemptions FROM access_campaign',
          )
        ).rows[0]?.redemptions,
      ).toBe(0);
    });
    it('does not shorten paid rights or consume a non-improving code', async () => {
      await pool.query<Record<string, unknown>>(
        "INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,current_period_ends_at,provider_event_occurred_at) VALUES($1,'stripe','sub_paid','prod_test','active','year',now()+interval '300 days',now())",
        [a],
      );
      await campaign('gift');
      await expect(claim(a, 'gift')).rejects.toThrow('access_not_improved');
      expect(
        (
          await pool.query<Record<string, unknown>>(
            'SELECT redemptions FROM access_campaign',
          )
        ).rows[0]?.redemptions,
      ).toBe(0);
      await pool.query<Record<string, unknown>>(
        'SELECT recompute_pressay_entitlement($1)',
        [a],
      );
      expect((await entitlement(a)).source).toBe('stripe');
    });
    it('revokes a grant independently and preserves an overlapping paid subscription', async () => {
      await campaign('gift', 90);
      await claim(a, 'gift');
      await pool.query<Record<string, unknown>>(
        "INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,current_period_ends_at,provider_event_occurred_at) VALUES($1,'stripe','sub_paid','prod_test','active','month',now()+interval '20 days',now())",
        [a],
      );
      await pool.query<Record<string, unknown>>(
        'SELECT revoke_pressay_grant(id) FROM access_grant',
      );
      expect((await entitlement(a)).source).toBe('stripe');
    });
    it('retains the first referrer and rejects self-attribution', async () => {
      expect((await attribute()).rows[0]?.ok).toBe(true);
      await pool.query<Record<string, unknown>>(
        "INSERT INTO referral_code(account_id,code) VALUES($1,'SECOND123456')",
        [c],
      );
      expect(
        (
          await pool.query<Record<string, unknown>>(
            "SELECT attribute_pressay_referral($1,'SECOND123456',now()) AS ok",
            [b],
          )
        ).rows[0]?.ok,
      ).toBe(false);
      expect(
        (
          await pool.query<Record<string, unknown>>(
            "SELECT attribute_pressay_referral($1,'ABCDEF123456',now()) AS ok",
            [a],
          )
        ).rows[0]?.ok,
      ).toBe(false);
    });
    it('creates exactly two rewards across duplicate and concurrent payments', async () => {
      await attribute();
      await Promise.all([
        pool.query<Record<string, unknown>>(
          "SELECT record_pressay_referral_payment('in_first',$1,now(),799,'eur')",
          [b],
        ),
        pool.query<Record<string, unknown>>(
          "SELECT record_pressay_referral_payment('in_first',$1,now(),799,'eur')",
          [b],
        ),
      ]);
      await pool.query<Record<string, unknown>>(
        "SELECT record_pressay_referral_payment('in_renewal',$1,now()+interval '30 days',799,'eur')",
        [b],
      );
      expect(
        (await pool.query<Record<string, unknown>>('SELECT * FROM referral_reward'))
          .rowCount,
      ).toBe(2);
      await pool.query<Record<string, unknown>>(
        "UPDATE referral_reward SET status='processing',kind='grant'",
      );
      await pool.query<Record<string, unknown>>(
        'SELECT apply_pressay_referral_grant(id) FROM referral_reward',
      );
      await pool.query<Record<string, unknown>>(
        'SELECT apply_pressay_referral_grant(id) FROM referral_reward',
      );
      expect(
        (await pool.query<Record<string, unknown>>('SELECT * FROM access_grant'))
          .rowCount,
      ).toBe(2);
      await pool.query<Record<string, unknown>>(
        "SELECT reverse_pressay_referral('in_first')",
      );
      expect((await entitlement(a)).tier).toBe('free');
      expect(
        (
          await pool.query<Record<string, unknown>>(
            "SELECT * FROM referral_reward WHERE status='cancelled'",
          )
        ).rowCount,
      ).toBe(2);
    });
    it('suppresses reward if a refund arrived before the invoice webhook', async () => {
      await attribute();
      await pool.query<Record<string, unknown>>(
        "SELECT reverse_pressay_referral('in_first')",
      );
      await pool.query<Record<string, unknown>>(
        "SELECT record_pressay_referral_payment('in_first',$1,now(),799,'eur')",
        [b],
      );
      expect(
        (await pool.query<Record<string, unknown>>('SELECT * FROM referral_reward'))
          .rowCount,
      ).toBe(0);
    });
    it('erases external identities without allowing a JWT to recreate their account', async () => {
      await pool.query('INSERT INTO account_contact(account_id,email) VALUES($1,$2)', [
        a,
        'verified@example.test',
      ]);
      await pool.query('SELECT request_pressay_account_deletion($1)', [a]);
      await pool.query(
        "UPDATE account_deletion_job SET state='processing' WHERE account_id=$1",
        [a],
      );
      await pool.query('DELETE FROM "user" WHERE id=$1', [a]);
      expect(
        (
          await pool.query<Record<string, unknown>>(
            'SELECT complete_pressay_account_deletion($1) AS completed',
            [a],
          )
        ).rows[0]?.completed,
      ).toBe(true);
      expect(
        (await pool.query('SELECT * FROM account_contact WHERE account_id=$1', [a]))
          .rowCount,
      ).toBe(0);
      await expect(
        pool.query('SELECT bootstrap_pressay_web_account($1)', [a]),
      ).rejects.toThrow('account_not_active');
    });
    it('does not reassign ownership when the original owner is deleted', async () => {
      await pool.query<Record<string, unknown>>(
        'INSERT INTO operations_owner(account_id) VALUES($1)',
        [a],
      );
      await pool.query<Record<string, unknown>>(
        'DELETE FROM pressay_account WHERE id=$1',
        [a],
      );
      await pool.query<Record<string, unknown>>(
        'INSERT INTO operations_owner(account_id) VALUES($1) ON CONFLICT DO NOTHING',
        [b],
      );
      expect(
        (
          await pool.query<Record<string, unknown>>(
            'SELECT account_id FROM operations_owner',
          )
        ).rows,
      ).toEqual([{ account_id: null }]);
    });
  },
);
