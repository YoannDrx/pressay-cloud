import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { SignJWT } from 'jose';
const sqlQuery = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { clearRemoteKeySetsForTests } from '../src/lib/auth-middleware.ts';
import { purgeExpiredRecords } from '../src/services/retention.ts';
import { csvField } from '../src/services/waitlist.ts';
import type { AdminWaitlist } from '../src/contracts/waitlist.ts';
import { configureTestJwks, externalAccessToken } from './helpers/identity.ts';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const migrationFile = new URL('../migrations/0027_waitlist.sql', import.meta.url);

describe('waitlist migration', () => {
  it('stores only the address, platform, language, source and consent', async () => {
    const migration = await readFile(migrationFile, 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS waitlist_entry');
    expect(migration).toContain("CHECK (platform IN ('ios', 'windows'))");
    expect(migration).toContain('UNIQUE (email, platform)');
    expect(migration).toContain('consent_at timestamptz NOT NULL');
    expect(migration).not.toMatch(/\b(ip_address|user_agent|inet)\b/i);
    expect(migration).not.toMatch(/^\s*CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/m);
  });
  it('quotes CSV fields and neutralises spreadsheet formulas', () => {
    expect(csvField('a@b.c')).toBe('"a@b.c"');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('+33')).toBe(`"'+33"`);
  });
});

describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'platform waitlists on PostgreSQL',
  () => {
    const schema = `waitlist_${randomUUID().replaceAll('-', '')}`;
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
      await pool.query(await readFile(migrationFile, 'utf8'));
    });
    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    beforeEach(async () => {
      vi.unstubAllGlobals();
      clearRemoteKeySetsForTests();
      await run(
        'TRUNCATE "user",pressay_account,operations_owner,operations_audit,waitlist_entry,rate_limit_bucket CASCADE',
      );
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_INTERNAL_JWT_SECRET =
        'local-operations-test-key-32-characters';
      process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
      process.env.RATE_LIMIT_HMAC_SECRET = 'local-rate-limit-test-key-32-characters';
      process.env.PRESSAY_OPERATIONS_OWNER_EMAILS = 'owner@example.com';
      clearEnvironmentCacheForTests();
      owner = randomUUID();
      await run(
        'INSERT INTO pressay_account(id,auth_user_id) VALUES($1::uuid,$1::text)',
        [owner],
      );
      await run(
        "INSERT INTO account_contact(account_id,email) VALUES($1,'owner@example.com')",
        [owner],
      );
    });

    const signup = (extra: Record<string, unknown> = {}) => ({
      email: 'Someone@Example.test',
      platform: 'ios',
      locale: 'fr',
      source: 'landing',
      consent: true,
      ...extra,
    });
    async function join(
      body: unknown,
      headers: Record<string, string> = { 'x-vercel-forwarded-for': '203.0.113.7' },
    ) {
      const response = await app.request('/v1/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: response.status, data: (await response.json()) as unknown };
    }
    async function admin(path: string, stepUp = true) {
      const token = await new SignJWT({
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
      return app.request(`/v1/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    }

    it('answers the same for a new, repeated or returning address and keeps one row', async () => {
      const first = await join(signup());
      expect(first).toEqual({ status: 202, data: { status: 'registered' } });
      expect(await join(signup({ locale: 'en', source: 'other' }))).toEqual(first);
      expect(
        await run('SELECT email,platform,locale,source FROM waitlist_entry'),
      ).toEqual([
        {
          email: 'someone@example.test',
          platform: 'ios',
          locale: 'fr',
          source: 'landing',
        },
      ]);
      await run(
        "UPDATE waitlist_entry SET unsubscribed_at=now(),consent_at=now()-interval '9 days'",
      );
      expect(await join(signup({ locale: 'en' }))).toEqual(first);
      const [row] = await run(
        "SELECT locale,unsubscribed_at,consent_at>now()-interval '1 minute' AS renewed FROM waitlist_entry",
      );
      expect(row).toEqual({ locale: 'en', unsubscribed_at: null, renewed: true });
      expect(await join(signup({ platform: 'windows' }))).toEqual(first);
      expect((await run('SELECT 1 FROM waitlist_entry')).length).toBe(2);
    });

    it('requires explicit consent, a valid address and a known platform', async () => {
      for (const [index, body] of [
        signup({ consent: false }),
        signup({ consent: undefined }),
        signup({ email: 'not-an-address' }),
        signup({ platform: 'android' }),
        signup({ locale: 'de' }),
        { ...signup(), ip: '1.2.3.4' },
      ].entries())
        // One visitor address per attempt: refused attempts count too.
        expect(
          (await join(body, { 'x-vercel-forwarded-for': `198.51.100.${index}` }))
            .status,
        ).toBe(422);
      expect(await run('SELECT 1 FROM waitlist_entry')).toEqual([]);
    });

    it('limits sign-ups per visitor address, including addresses vouched for by the site', async () => {
      for (let index = 0; index < 5; index += 1)
        expect((await join(signup({ email: `p${index}@example.test` }))).status).toBe(
          202,
        );
      expect((await join(signup({ email: 'p6@example.test' }))).status).toBe(429);
      // Another visitor is not affected.
      expect(
        (
          await join(signup({ email: 'other@example.test' }), {
            'x-vercel-forwarded-for': '198.51.100.9',
          })
        ).status,
      ).toBe(202);
      // The site relays from one server address but vouches for each visitor.
      await configureTestJwks();
      const vouch = (address: string) =>
        externalAccessToken(
          { token_use: 'pressay_waitlist', client_address: address },
          { subject: 'press-say.app', audience: 'pressay-waitlist' },
        );
      for (let index = 0; index < 5; index += 1)
        expect(
          (
            await join(signup({ email: `s${index}@example.test` }), {
              'x-vercel-forwarded-for': '203.0.113.7',
              authorization: `Bearer ${await vouch('192.0.2.44')}`,
            })
          ).status,
        ).toBe(202);
      expect(
        (
          await join(signup({ email: 's6@example.test' }), {
            authorization: `Bearer ${await vouch('192.0.2.44')}`,
          })
        ).status,
      ).toBe(429);
      const download = await externalAccessToken(
        { token_use: 'pressay_download_event' },
        { subject: 'press-say.app', audience: 'pressay-download-event' },
      );
      expect(
        (await join(signup(), { authorization: `Bearer ${download}` })).status,
      ).toBe(401);
      expect(
        JSON.stringify(await run('SELECT * FROM rate_limit_bucket')),
      ).not.toContain('192.0.2.44');
    });

    it('gives the owner counters, and the address export only after step-up, audited', async () => {
      await join(signup());
      await join(signup({ email: 'b@example.test', locale: 'en', source: 'pricing' }));
      await join(signup({ email: 'c@example.test', platform: 'windows' }));
      await join(signup({ email: 'd@example.test', platform: 'windows' }));
      await run(
        "UPDATE waitlist_entry SET unsubscribed_at=now() WHERE email='c@example.test'",
      );
      const summary = await admin('admin/waitlist', false);
      expect(summary.status).toBe(200);
      expect(((await summary.json()) as AdminWaitlist).platforms).toMatchObject([
        {
          platform: 'ios',
          subscribed: 2,
          unsubscribed: 0,
          french: 1,
          english: 1,
          last_7d: 2,
        },
        { platform: 'windows', subscribed: 1, unsubscribed: 1, french: 1, english: 0 },
      ]);
      expect((await admin('admin/waitlist/export?platform=ios', false)).status).toBe(
        403,
      );
      expect((await admin('admin/waitlist/export?platform=mac')).status).toBe(422);
      const exported = await admin('admin/waitlist/export?platform=windows');
      expect(exported.status).toBe(200);
      expect(exported.headers.get('content-disposition')).toBe(
        'attachment; filename="pressay-waitlist-windows.csv"',
      );
      const csv = await exported.text();
      expect(csv.split('\r\n')[0]).toBe(
        'email,platform,locale,source,consent_at,created_at',
      );
      expect(csv).toContain('"d@example.test","windows","fr","landing"');
      expect(csv).not.toContain('c@example.test"');
      expect(
        await run(
          "SELECT action,target_id,reason FROM operations_audit WHERE action='admin.waitlist.export'",
        ),
      ).toEqual([
        {
          action: 'admin.waitlist.export',
          target_id: 'waitlist/windows',
          reason: 'personal_data_read',
        },
      ]);
    });

    it('purges entries whose consent lapsed and unsubscriptions after 30 days', async () => {
      await run(
        `INSERT INTO waitlist_entry(email,platform,locale,source,consent_at,unsubscribed_at) VALUES
        ('old@example.test','ios','fr','site',now()-interval '731 days',NULL),
        ('gone@example.test','ios','fr','site',now()-interval '60 days',now()-interval '31 days'),
        ('recent-out@example.test','ios','fr','site',now()-interval '60 days',now()-interval '2 days'),
        ('kept@example.test','windows','en','site',now()-interval '700 days',NULL)`,
      );
      const purged = await purgeExpiredRecords();
      expect(purged.waitlistEntries).toBe(2);
      expect(await run('SELECT email FROM waitlist_entry ORDER BY email')).toEqual([
        { email: 'kept@example.test' },
        { email: 'recent-out@example.test' },
      ]);
    });
  },
);
