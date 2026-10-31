import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { SignJWT } from 'jose';
const sqlQuery = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import type {
  AdminAuditLog,
  AdminUserDetail,
  DeviceActionResult,
  SupportGrantResult,
} from '../src/contracts/operations-wire.ts';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'admin support actions on PostgreSQL',
  () => {
    const schema = `admin_support_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const migration = async (file: string) =>
      readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    let owner: string;
    let legacy: { account: string; grant: string };
    let backfill: { request_id: string; target_account_id: string | null }[] = [];
    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      sqlQuery.mockImplementation(
        async (sql: string, values: unknown[]) =>
          (await pool.query<Record<string, unknown>>(sql, values)).rows,
      );
      const files = (await readdir(new URL('../migrations', import.meta.url)))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      // Apply up to 0023, write audit rows the old way, then apply the rest:
      // 0024 must attach them to their account.
      for (const file of files.filter((f) => f < '0024'))
        await pool.query(await migration(file));
      const account = randomUUID();
      await pool.query(
        'INSERT INTO pressay_account(id,auth_user_id) VALUES($1::uuid,$1::text)',
        [account],
      );
      const grant = await pool.query<{ id: string }>(
        "INSERT INTO access_grant(account_id,source,ends_at) VALUES($1,'legacy',now()+interval '3 days') RETURNING id",
        [account],
      );
      legacy = { account, grant: String(grant.rows[0]?.id) };
      await pool.query(
        `INSERT INTO operations_audit(actor_id,action,target_id,reason,request_id) VALUES
        (NULL,'admin.user.read',$1,'personal_data_read','r1'),
        (NULL,'grant.revoked',$2,'Old entry','r2'),
        (NULL,'launch_gate.updated','direct/tax','Gate','r3')`,
        [account, legacy.grant],
      );
      for (const file of files.filter((f) => f >= '0024'))
        await pool.query(await migration(file));
      // Replaying the file changes nothing.
      await pool.query(await migration('0024_admin_support.sql'));
      backfill = (
        await pool.query<{ request_id: string; target_account_id: string | null }>(
          "SELECT request_id,target_account_id FROM operations_audit WHERE request_id IN ('r1','r2','r3') ORDER BY request_id",
        )
      ).rows;
    });
    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    beforeEach(async () => {
      await pool.query(
        'TRUNCATE "user",pressay_account,operations_owner,operations_audit,operations_request,rate_limit_bucket CASCADE',
      );
      owner = await account('owner@example.com');
    });

    async function account(email: string | null, status = 'active') {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO pressay_account(id,auth_user_id,status) VALUES($1::uuid,$1::text,$2)',
        [id, status],
      );
      await pool.query('INSERT INTO entitlement(account_id) VALUES($1)', [id]);
      if (email)
        await pool.query(
          'INSERT INTO account_contact(account_id,email) VALUES($1,$2)',
          [id, email],
        );
      return id;
    }
    async function device(accountId: string, revoked = false) {
      const hash = randomBytes(32);
      const rows = await pool.query<{ id: string }>(
        `INSERT INTO pressay_device(account_id,device_identifier_hash,display_name,platform,app_variant,app_version,revoked_at)
        VALUES($1,$2,'Work computer','windows','direct','1.4.0',$3) RETURNING id`,
        [accountId, hash, revoked ? new Date() : null],
      );
      return { id: String(rows.rows[0]?.id), hash };
    }
    async function entitlement(accountId: string) {
      const rows = await pool.query<{
        tier: string;
        source: string;
        valid_until: Date | null;
      }>('SELECT tier,source,valid_until FROM entitlement WHERE account_id=$1', [
        accountId,
      ]);
      const [row] = rows.rows;
      if (!row) throw new Error('entitlement missing');
      return row;
    }
    async function auditRows(action: string) {
      return (
        await pool.query<{
          action: string;
          result: string;
          target_id: string;
          target_account_id: string | null;
          details: Record<string, unknown> | null;
          reason: string;
        }>(
          'SELECT action,result,target_id,target_account_id,details,reason FROM operations_audit WHERE action LIKE $1 ORDER BY id',
          [`${action}%`],
        )
      ).rows;
    }
    async function token(subject: string, stepUp = true) {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_INTERNAL_JWT_SECRET =
        'local-operations-test-key-32-characters';
      process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
      process.env.PRESSAY_CAMPAIGN_SECRET = 'local-campaign-test-key-32-characters';
      process.env.RATE_LIMIT_HMAC_SECRET = 'local-rate-limit-test-key-32-characters';
      process.env.PRESSAY_OPERATIONS_OWNER_EMAILS = 'owner@example.com';
      clearEnvironmentCacheForTests();
      return new SignJWT({
        email: subject === owner ? 'owner@example.com' : `${subject}@example.test`,
        email_verified: true,
        token_use: 'pressay_web_proxy',
        sid: 'session',
        pressay_step_up_method: 'totp',
        pressay_step_up_at: stepUp ? Math.floor(Date.now() / 1000) : 0,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(subject)
        .setIssuer('https://press-say.app/internal')
        .setAudience('pressay-api')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(new TextEncoder().encode(process.env.PRESSAY_INTERNAL_JWT_SECRET));
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test responses
    async function api<T = unknown>(
      path: string,
      init: {
        method?: string;
        body?: unknown;
        subject?: string;
        stepUp?: boolean;
      } = {},
    ): Promise<{ status: number; data: T }> {
      const response = await app.request(`/v1/${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          authorization: `Bearer ${await token(init.subject ?? owner, init.stepUp ?? true)}`,
          'content-type': 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { status: response.status, data: (await response.json()) as T };
    }
    const action = (extra: Record<string, unknown> = {}) => ({
      idempotencyKey: randomUUID(),
      reason: 'Support ticket 42',
      ...extra,
    });

    it('attaches earlier audit entries to their account and keeps other targets', () => {
      expect(backfill).toEqual([
        { request_id: 'r1', target_account_id: legacy.account },
        { request_id: 'r2', target_account_id: legacy.account },
        { request_id: 'r3', target_account_id: null },
      ]);
    });

    it('offers Pro with a reason, recomputes access and replays the same key once', async () => {
      const customer = await account('customer@example.test');
      const input = action({ days: 30 });
      const first = await api<SupportGrantResult>(`admin/users/${customer}/grants`, {
        body: input,
      });
      expect(first.status, JSON.stringify(first.data)).toBe(201);
      expect(first.data).toMatchObject({
        accountId: customer,
        days: 30,
        replayed: false,
      });
      expect(await entitlement(customer)).toMatchObject({
        tier: 'pro',
        source: 'support',
      });
      const grant = (
        await pool.query<{ ends_at: Date }>(
          'SELECT source,reason,created_by,ends_at FROM access_grant WHERE account_id=$1',
          [customer],
        )
      ).rows;
      expect(grant).toMatchObject([
        { source: 'support', reason: 'Support ticket 42', created_by: owner },
      ]);
      const days = ((grant[0]?.ends_at.getTime() ?? 0) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);

      const replay = await api<SupportGrantResult>(`admin/users/${customer}/grants`, {
        body: input,
      });
      expect(replay.status).toBe(201);
      expect(replay.data).toMatchObject({
        grantId: first.data.grantId,
        replayed: true,
      });
      expect(
        (await pool.query('SELECT 1 FROM access_grant WHERE account_id=$1', [customer]))
          .rowCount,
      ).toBe(1);
      const audit = await auditRows('grant.create');
      expect(audit.map((row) => row.result)).toEqual([
        'requested',
        'succeeded',
        'requested',
        'replayed',
      ]);
      expect(audit[1]).toMatchObject({
        target_id: customer,
        target_account_id: customer,
        details: { grantId: first.data.grantId, days: 30, replayed: false },
      });
      expect(JSON.stringify(audit)).not.toContain('@');

      const other = await account(null);
      const reused = await api(`admin/users/${other}/grants`, { body: input });
      expect(reused).toMatchObject({
        status: 409,
        data: { error: { code: 'request_key_reused' } },
      });
    });

    it('refuses to offer Pro to an account being deleted and records the failure', async () => {
      const leaving = await account(null, 'deleting');
      const response = await api(`admin/users/${leaving}/grants`, {
        body: action({ days: 7 }),
      });
      expect(response).toMatchObject({
        status: 409,
        data: { error: { code: 'account_not_active' } },
      });
      expect((await auditRows('grant.create')).at(-1)).toMatchObject({
        result: 'failed',
        target_account_id: leaving,
        details: { errorCode: 'account_not_active' },
      });
      expect(
        (await api(`admin/users/${leaving}/grants`, { body: action({ days: 0 }) }))
          .status,
      ).toBe(422);
    });

    it('extends grants from their end, or from now once ended, but not revoked ones', async () => {
      const customer = await account(null);
      const grants = await pool.query<{ id: string }>(
        `INSERT INTO access_grant(account_id,source,starts_at,ends_at,revoked_at) VALUES
        ($1,'invitation',now()-interval '1 day',now()+interval '10 days',NULL),
        ($1,'referral',now()-interval '40 days',now()-interval '10 days',NULL),
        ($1,'support',now()-interval '1 day',now()+interval '5 days',now())
        RETURNING id`,
        [customer],
      );
      const [running, ended, revoked] = grants.rows.map((row) => row.id);
      const extended = await api<SupportGrantResult>(`admin/grants/${running}/extend`, {
        body: action({ days: 20 }),
      });
      expect(extended.status, JSON.stringify(extended.data)).toBe(200);
      const runningDays =
        (new Date(extended.data.endsAt).getTime() - Date.now()) / 86_400_000;
      expect(runningDays).toBeGreaterThan(29.9);
      expect(runningDays).toBeLessThan(30.1);
      const revived = await api<SupportGrantResult>(`admin/grants/${ended}/extend`, {
        body: action({ days: 5 }),
      });
      const revivedDays =
        (new Date(revived.data.endsAt).getTime() - Date.now()) / 86_400_000;
      expect(revivedDays).toBeGreaterThan(4.9);
      expect(revivedDays).toBeLessThan(5.1);
      expect(
        await api(`admin/grants/${revoked}/extend`, { body: action({ days: 5 }) }),
      ).toMatchObject({ status: 409, data: { error: { code: 'grant_revoked' } } });
      expect(
        (
          await api(`admin/grants/${randomUUID()}/extend`, {
            body: action({ days: 5 }),
          })
        ).status,
      ).toBe(404);
      const valid = (await entitlement(customer)).valid_until;
      expect(valid?.toISOString()).toBe(new Date(extended.data.endsAt).toISOString());
      expect((await auditRows('grant.extend')).at(1)).toMatchObject({
        result: 'succeeded',
        target_id: running,
        target_account_id: customer,
        details: { days: 20 },
      });

      const revoke = await api(`admin/grants/${running}/revoke`, {
        body: { reason: 'Ended early' },
      });
      expect(revoke).toMatchObject({ status: 200, data: { revoked: true } });
      expect((await auditRows('grant.revoke')).at(-1)).toMatchObject({
        result: 'succeeded',
        target_account_id: customer,
      });
    });

    it('lets support and the owner restore a revoked computer within three active devices', async () => {
      const customer = await account('customer@example.test');
      const computer = await device(customer);
      const revoked = await api<DeviceActionResult>(
        `admin/devices/${computer.id}/revoke`,
        {
          body: action(),
        },
      );
      expect(revoked.data).toMatchObject({
        accountId: customer,
        platform: 'windows',
        changed: true,
      });
      expect(
        (
          await api<DeviceActionResult>(`admin/devices/${computer.id}/revoke`, {
            body: action(),
          })
        ).data.changed,
      ).toBe(false);
      // The defect: a revoked computer was refused at every later sign-in.
      const bootstrap = () =>
        pool.query(
          "SELECT * FROM bootstrap_pressay_account($1,$2,'Work computer','direct','1.4.1','windows')",
          [customer, computer.hash],
        );
      await expect(bootstrap()).rejects.toThrow('device_revoked');

      for (let index = 0; index < 3; index += 1) await device(customer);
      const full = await api(`admin/devices/${computer.id}/restore`, {
        body: action(),
      });
      expect(full).toMatchObject({
        status: 409,
        data: { error: { code: 'device_limit_reached' } },
      });
      const listed = await api<{
        devices: unknown[];
        revokedDevices: { id: string }[];
      }>('devices?include=revoked', { subject: customer });
      expect(listed.data.devices).toHaveLength(3);
      expect(listed.data.revokedDevices.map((d) => d.id)).toEqual([computer.id]);
      expect(
        (await api<Record<string, unknown>>('devices', { subject: customer })).data,
      ).not.toHaveProperty('revokedDevices');

      await pool.query(
        'UPDATE pressay_device SET revoked_at=now() WHERE account_id=$1 AND id<>$2 AND revoked_at IS NULL AND ctid IN (SELECT ctid FROM pressay_device WHERE account_id=$1 AND id<>$2 AND revoked_at IS NULL LIMIT 1)',
        [customer, computer.id],
      );
      const restoreKey = action();
      const restored = await api<DeviceActionResult>(
        `admin/devices/${computer.id}/restore`,
        {
          body: restoreKey,
        },
      );
      expect(restored.data).toMatchObject({ changed: true, replayed: false });
      expect(
        (
          await api<DeviceActionResult>(`admin/devices/${computer.id}/restore`, {
            body: restoreKey,
          })
        ).data,
      ).toMatchObject({ changed: true, replayed: true });
      await expect(bootstrap()).resolves.toBeTruthy();
      expect((await auditRows('device.restore')).map((row) => row.result)).toEqual([
        'requested',
        'failed',
        'requested',
        'succeeded',
        'requested',
        'replayed',
      ]);

      // The owner restores from the account page, only their own devices.
      await pool.query('UPDATE pressay_device SET revoked_at=now() WHERE id=$1', [
        computer.id,
      ]);
      const stranger = await account(null);
      expect(
        (
          await api(`devices/${computer.id}/restore`, {
            method: 'POST',
            body: {},
            subject: stranger,
          })
        ).status,
      ).toBe(404);
      expect(
        await api(`devices/${computer.id}/restore`, {
          method: 'POST',
          body: {},
          subject: customer,
          stepUp: false,
        }),
      ).toMatchObject({ status: 200, data: { restored: true } });
      expect(
        (
          await pool.query('SELECT revoked_at FROM pressay_device WHERE id=$1', [
            computer.id,
          ])
        ).rows[0],
      ).toEqual({ revoked_at: null });
    });

    it('queues an account deletion with a reason, never the owner, and asks about Apple', async () => {
      const customer = await account('customer@example.test');
      await device(customer);
      await pool.query(
        `INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,current_period_ends_at,cancel_at_period_end,apple_environment,provider_event_occurred_at)
        VALUES($1,'app_store','2000000123456789','pro.yearly','active','year',now()+interval '200 days',false,'Production',now())`,
        [customer],
      );
      expect(
        await api(`admin/users/${customer}/deletion`, { body: action() }),
      ).toMatchObject({
        status: 409,
        data: { error: { code: 'apple_subscription_active' } },
      });
      expect(
        await api(`admin/users/${customer}/deletion`, {
          body: action({ acknowledgeAppleSubscription: 'true' }),
        }),
      ).toMatchObject({ status: 202, data: { status: 'deleting' } });
      expect(
        (
          await pool.query(
            `SELECT a.status,j.state,(SELECT count(*)::int FROM pressay_device WHERE account_id=a.id AND revoked_at IS NULL) AS active
            FROM pressay_account a JOIN account_deletion_job j ON j.account_id=a.id WHERE a.id=$1`,
            [customer],
          )
        ).rows,
      ).toEqual([{ status: 'deleting', state: 'queued', active: 0 }]);
      expect((await auditRows('account.deletion')).at(-1)).toMatchObject({
        result: 'succeeded',
        target_account_id: customer,
        details: { previousStatus: 'active', appleAcknowledged: true },
      });
      expect(
        await api(`admin/users/${owner}/deletion`, { body: action() }),
      ).toMatchObject({ status: 409, data: { error: { code: 'cannot_target_self' } } });
      expect(
        (await api(`admin/users/${customer}/deletion`, { body: { reason: 'No key' } }))
          .status,
      ).toBe(422);
    });

    it('records web-side sign-outs once per key and returns only the identity subject', async () => {
      const customer = await account('customer@example.test');
      const key = randomUUID();
      const requested = {
        idempotencyKey: key,
        reason: 'Lost laptop',
        action: 'user.sessions.revoke',
        targetAccountId: customer,
        result: 'requested',
      };
      expect(await api('admin/audit/external', { body: requested })).toMatchObject({
        status: 200,
        data: { recorded: true, authUserId: customer },
      });
      await api('admin/audit/external', { body: requested });
      const succeeded = {
        ...requested,
        result: 'succeeded',
        details: { webSessions: 2, oauthRefreshTokens: 1, oauthAccessTokens: 1 },
      };
      await api('admin/audit/external', { body: succeeded });
      await api('admin/audit/external', { body: succeeded });
      const rows = await auditRows('user.sessions.revoke');
      expect(rows.map((row) => row.result)).toEqual(['requested', 'succeeded']);
      expect(rows[1]).toMatchObject({
        target_account_id: customer,
        details: { webSessions: 2, oauthRefreshTokens: 1, oauthAccessTokens: 1 },
      });
      expect(
        (
          await api('admin/audit/external', {
            body: {
              ...requested,
              idempotencyKey: randomUUID(),
              details: { email: 'x@y.z' },
            },
          })
        ).status,
      ).toBe(422);
      expect(
        await api('admin/audit/external', {
          body: { ...requested, idempotencyKey: randomUUID(), targetAccountId: owner },
        }),
      ).toMatchObject({ status: 409, data: { error: { code: 'cannot_target_self' } } });
      expect(
        (
          await api('admin/audit/external', {
            body: requested,
            stepUp: false,
          })
        ).status,
      ).toBe(403);
    });

    it('pages and filters the audit ledger with the full author, under step-up', async () => {
      const customer = await account('customer@example.test');
      for (let index = 0; index < 55; index += 1)
        await pool.query(
          `INSERT INTO operations_audit(actor_id,action,target_id,target_account_id,reason,request_id,created_at)
          VALUES($1,'grant.extend',$2::text,$2::uuid,'Batch',$3,now()-make_interval(days=>$4))`,
          [owner, customer, `batch-${index}`, index % 3],
        );
      await pool.query(
        `INSERT INTO operations_audit(actor_id,action,target_id,reason,request_id,created_at)
        VALUES($1,'launch_gate.updated','direct/tax','Gate','gate',now()-interval '20 days')`,
        [owner],
      );
      expect((await api('admin/audit-log', { stepUp: false })).status).toBe(403);

      const first = await api<AdminAuditLog>(`admin/audit-log?target=${customer}`);
      expect(first.status).toBe(200);
      expect(first.data.entries).toHaveLength(50);
      expect(first.data.entries[0]).toMatchObject({
        actor_id: owner,
        actor_email: 'owner@example.com',
        target_account_id: customer,
      });
      const second = await api<AdminAuditLog>(
        `admin/audit-log?target=${customer}&cursor=${first.data.nextCursor}`,
      );
      expect(second.data.entries).toHaveLength(5);
      expect(second.data.nextCursor).toBeNull();

      const gates = await api<AdminAuditLog>('admin/audit-log?action=launch_gate');
      expect(gates.data.entries.map((entry) => entry.request_id)).toEqual(['gate']);
      const today = new Date().toISOString().slice(0, 10);
      const recent = await api<AdminAuditLog>(
        `admin/audit-log?action=grant&from=${today}&to=${today}`,
      );
      expect(recent.data.entries.length).toBeGreaterThan(10);
      expect(recent.data.entries.length).toBeLessThan(25);
      // Ledger reads are themselves audited, and can be hidden.
      const withReads = await api<AdminAuditLog>('admin/audit-log?action=admin.audit');
      expect(withReads.data.entries.length).toBeGreaterThan(0);
      const withoutReads = await api<AdminAuditLog>(
        'admin/audit-log?action=admin.audit&reads=exclude',
      );
      expect(withoutReads.data.entries).toEqual([]);
      expect((await api('admin/audit-log?action=DROP%20TABLE')).status).toBe(422);
    });

    it('shows support entries, grant reasons and their author in the customer record', async () => {
      const customer = await account('customer@example.test');
      await api(`admin/users/${customer}/grants`, { body: action({ days: 3 }) });
      const detail = await api<AdminUserDetail>(`admin/users/${customer}`);
      expect(detail.data.grants).toMatchObject([
        { source: 'support', reason: 'Support ticket 42', created_by: owner },
      ]);
      expect(detail.data.audit?.map((entry) => entry.action)).toEqual([
        'grant.create',
        'grant.create.requested',
      ]);
      expect(detail.data.audit?.[0]).toMatchObject({
        target_account_id: customer,
        details: { days: 3 },
      });
    });
  },
);
