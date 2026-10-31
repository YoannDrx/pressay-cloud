import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { SignJWT } from 'jose';
const sqlQuery = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import type { AdminMembers } from '../src/contracts/operations-wire.ts';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'administrators with roles on PostgreSQL',
  () => {
    const schema = `admin_members_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const run = async (sql: string, values: unknown[] = []) =>
      (await pool.query<Record<string, unknown>>(sql, values)).rows;
    const migration = async (file: string) =>
      readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    const webhook = vi.fn();
    let legacyOwner: string;
    let migrated: Record<string, unknown>[] = [];

    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      sqlQuery.mockImplementation(async (sql: string, values: unknown[]) =>
        run(sql, values),
      );
      const files = (await readdir(new URL('../migrations', import.meta.url)))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files.filter((f) => f < '0030'))
        await pool.query(await migration(file));
      // The owner claimed by the code running before this release.
      legacyOwner = await account('legacy@example.com');
      await run(
        'INSERT INTO operations_owner(singleton,account_id) VALUES(true,$1) ON CONFLICT DO NOTHING',
        [legacyOwner],
      );
      for (const file of files.filter((f) => f >= '0030'))
        await pool.query(await migration(file));
      await pool.query(await migration('0030_operations_members.sql'));
      migrated = await run('SELECT account_id,role,added_by FROM operations_member');
    });
    afterAll(async () => {
      vi.unstubAllGlobals();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    beforeEach(async () => {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_INTERNAL_JWT_SECRET =
        'local-operations-test-key-32-characters';
      process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
      process.env.RATE_LIMIT_HMAC_SECRET = 'local-rate-limit-test-key-32-characters';
      process.env.PRESSAY_OPERATIONS_OWNER_EMAILS =
        'owner@example.com,backup@example.com';
      process.env.OPS_ALERT_WEBHOOK_URL = 'https://hooks.example.test/ops';
      clearEnvironmentCacheForTests();
      webhook.mockReset();
      webhook.mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal('fetch', webhook);
      await run(
        'TRUNCATE operations_member,operations_audit,operations_request,rate_limit_bucket CASCADE',
      );
      await run('DELETE FROM pressay_account WHERE id<>$1', [legacyOwner]);
    });

    async function account(email: string) {
      const id = randomUUID();
      await run(
        'INSERT INTO pressay_account(id,auth_user_id) VALUES($1::uuid,$1::text)',
        [id],
      );
      await run('INSERT INTO entitlement(account_id) VALUES($1)', [id]);
      await run('INSERT INTO account_contact(account_id,email) VALUES($1,$2)', [
        id,
        email,
      ]);
      return id;
    }
    async function call(
      subject: string,
      email: string,
      method: string,
      path: string,
      body?: unknown,
      claims: Record<string, unknown> = {},
    ) {
      const token = await new SignJWT({
        email,
        email_verified: true,
        token_use: 'pressay_web_proxy',
        sid: 'session',
        pressay_step_up_method: 'totp',
        pressay_step_up_at: Math.floor(Date.now() / 1000),
        pressay_two_factor: true,
        ...claims,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(subject)
        .setIssuer('https://press-say.app/internal')
        .setAudience('pressay-api')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(new TextEncoder().encode(process.env.PRESSAY_INTERNAL_JWT_SECRET));
      const response = await app.request(`/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        data: (await response.json()) as Record<string, unknown>,
      };
    }
    const action = (extra: Record<string, unknown> = {}) => ({
      idempotencyKey: randomUUID(),
      reason: 'New support teammate',
      ...extra,
    });
    function alerts() {
      return webhook.mock.calls.map(
        ([, init]) =>
          JSON.parse((init as { body: string }).body) as Record<string, unknown>,
      );
    }

    it('turns the existing owner into an owner member, once, without breaking the previous code', async () => {
      expect(migrated).toEqual([
        { account_id: legacyOwner, role: 'owner', added_by: null },
      ]);
      // Queries of the code running before this release still work.
      await run(
        'INSERT INTO operations_owner(singleton,account_id) VALUES(true,$1) ON CONFLICT DO NOTHING',
        [legacyOwner],
      );
      expect(
        await run('SELECT account_id FROM operations_owner WHERE account_id=$1', [
          legacyOwner,
        ]),
      ).toEqual([{ account_id: legacyOwner }]);
    });

    it('lets a listed address claim the owner seat only with Authenticator and while no active owner exists', async () => {
      const first = await account('owner@example.com');
      const second = await account('backup@example.com');
      const withoutTotp = await call(
        first,
        'owner@example.com',
        'GET',
        'admin/session',
        undefined,
        {
          pressay_two_factor: false,
        },
      );
      expect(withoutTotp).toMatchObject({
        status: 403,
        data: { error: { code: 'admin_required' } },
      });
      expect(await run('SELECT * FROM operations_member')).toEqual([]);

      expect(await call(first, 'owner@example.com', 'GET', 'admin/session')).toEqual({
        status: 200,
        data: { role: 'owner', accountId: first },
      });
      expect(
        await run(
          "SELECT actor_id,action,result,details FROM operations_audit WHERE action='member.owner.claimed'",
        ),
      ).toEqual([
        {
          actor_id: first,
          action: 'member.owner.claimed',
          result: 'succeeded',
          details: { role: 'owner' },
        },
      ]);
      expect(alerts()).toEqual([
        expect.objectContaining({
          event: 'operations_member.owner_claimed',
          accountId: first,
          role: 'owner',
          service: 'pressay-cloud',
        }),
      ]);
      // A second listed address does not become owner while one is active.
      expect(
        (await call(second, 'backup@example.com', 'GET', 'admin/session')).status,
      ).toBe(403);
      // Recovery: once the only owner's account is deleted, it can.
      await run("UPDATE pressay_account SET status='deleted' WHERE id=$1", [first]);
      expect(
        (await call(second, 'backup@example.com', 'GET', 'admin/session')).data,
      ).toEqual({
        role: 'owner',
        accountId: second,
      });
      expect(JSON.stringify(alerts())).not.toContain('@');
    });

    it('lets the owner add, change and remove members, audited and announced, keeping one owner', async () => {
      const owner = await account('owner@example.com');
      await call(owner, 'owner@example.com', 'GET', 'admin/session');
      webhook.mockClear();
      const helper = await account('Helper@Example.test');
      const as = (method: string, path: string, body?: unknown) =>
        call(owner, 'owner@example.com', method, path, body);

      expect(
        await as(
          'POST',
          'admin/members',
          action({ email: 'nobody@example.test', role: 'support' }),
        ),
      ).toMatchObject({ status: 404, data: { error: { code: 'account_not_found' } } });
      const addition = action({ email: 'helper@example.test', role: 'support' });
      expect(await as('POST', 'admin/members', addition)).toEqual({
        status: 200,
        data: {
          accountId: helper,
          previousRole: null,
          role: 'support',
          changed: true,
          replayed: false,
        },
      });
      // Replaying the same form changes nothing and alerts once.
      expect((await as('POST', 'admin/members', addition)).data).toMatchObject({
        replayed: true,
      });
      expect(
        (await as('POST', 'admin/members', { ...addition, role: 'readonly' })).data,
      ).toMatchObject({ error: { code: 'request_key_reused' } });

      expect(
        (await as('POST', `admin/members/${helper}/role`, action({ role: 'readonly' })))
          .data,
      ).toMatchObject({ previousRole: 'support', role: 'readonly', changed: true });
      const list = (await as('GET', 'admin/members')).data as unknown as AdminMembers;
      expect(list.members).toEqual([
        expect.objectContaining({
          accountId: owner,
          role: 'owner',
          email: 'owner@example.com',
          addedBy: null,
        }),
        expect.objectContaining({
          accountId: helper,
          authUserId: helper,
          role: 'readonly',
          email: 'Helper@Example.test',
          addedBy: owner,
          addedByEmail: 'owner@example.com',
        }),
      ]);

      // The last owner can be neither demoted nor removed.
      expect(
        (await as('POST', `admin/members/${owner}/role`, action({ role: 'support' })))
          .data,
      ).toMatchObject({ error: { code: 'last_owner' } });
      expect(
        (await as('POST', `admin/members/${owner}/remove`, action())).data,
      ).toMatchObject({
        error: { code: 'last_owner' },
      });
      expect(
        (await as('POST', `admin/members/${helper}/remove`, action())).data,
      ).toMatchObject({
        previousRole: 'readonly',
        role: null,
      });
      expect(
        (await as('POST', `admin/members/${helper}/remove`, action())).data,
      ).toMatchObject({
        error: { code: 'member_not_found' },
      });

      expect(
        alerts().map((alert) => [alert.event, alert.previousRole, alert.role]),
      ).toEqual([
        ['operations_member.changed', null, 'support'],
        ['operations_member.changed', 'support', 'readonly'],
        ['operations_member.changed', 'readonly', null],
      ]);
      expect(JSON.stringify(alerts())).not.toContain('@');
      const ledger = await run(
        `SELECT action,target_id,result,details FROM operations_audit
        WHERE action IN ('member.role.set','member.remove') AND result<>'requested' ORDER BY id`,
      );
      expect(ledger.map((row) => [row.action, row.result])).toEqual([
        ['member.role.set', 'succeeded'],
        ['member.role.set', 'replayed'],
        ['member.role.set', 'failed'],
        ['member.role.set', 'succeeded'],
        ['member.role.set', 'failed'],
        ['member.remove', 'failed'],
        ['member.remove', 'succeeded'],
        ['member.remove', 'failed'],
      ]);
      expect(ledger[0]).toMatchObject({
        target_id: helper,
        details: {
          role: 'support',
          previousRole: null,
          changed: true,
          replayed: false,
        },
      });
      expect(JSON.stringify(ledger)).not.toContain('@');
    });

    it('applies each role to real routes', async () => {
      const owner = await account('owner@example.com');
      await call(owner, 'owner@example.com', 'GET', 'admin/session');
      const support = await account('support@example.test');
      const viewer = await account('viewer@example.test');
      const customer = await account('customer@example.test');
      await call(
        owner,
        'owner@example.com',
        'POST',
        'admin/members',
        action({ email: 'support@example.test', role: 'support' }),
      );
      await call(
        owner,
        'owner@example.com',
        'POST',
        'admin/members',
        action({ email: 'viewer@example.test', role: 'readonly' }),
      );

      expect(
        (
          await call(
            support,
            'support@example.test',
            'POST',
            `admin/users/${customer}/grants`,
            action({ days: 7 }),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await call(
            support,
            'support@example.test',
            'POST',
            'admin/billing/events/stripe/evt_1/replay',
            action(),
          )
        ).data,
      ).toMatchObject({ error: { code: 'role_forbidden' } });
      expect(
        (await call(support, 'support@example.test', 'GET', 'admin/members')).status,
      ).toBe(403);
      expect(
        (await call(viewer, 'viewer@example.test', 'GET', `admin/users/${customer}`))
          .status,
      ).toBe(200);
      expect(
        (
          await call(
            viewer,
            'viewer@example.test',
            'POST',
            `admin/users/${customer}/grants`,
            action({ days: 7 }),
          )
        ).data,
      ).toMatchObject({ error: { code: 'role_forbidden' } });
      expect(
        (
          await call(viewer, 'viewer@example.test', 'GET', 'admin/session', undefined, {
            pressay_two_factor: false,
          })
        ).data,
      ).toMatchObject({ error: { code: 'two_factor_required' } });
      // A member cannot manage members by calling the database function either.
      await expect(
        run('SELECT set_pressay_operations_member($1,$2,$3,$4)', [
          support,
          viewer,
          'owner',
          randomUUID(),
        ]),
      ).rejects.toThrow('owner_required');
    });
  },
);
