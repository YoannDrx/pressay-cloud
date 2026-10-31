import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { SignJWT } from 'jose';
const sqlQuery = vi.hoisted(() => vi.fn());
const deleteStripeCustomer = vi.hoisted(() => vi.fn());
const deleteWebIdentity = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({ customers: { del: deleteStripeCustomer } }),
}));
vi.mock('../src/services/web-identity.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof WebIdentityModule>()),
  deleteWebIdentity,
}));
import type * as WebIdentityModule from '../src/services/web-identity.ts';
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { runAccountDeletionBatch } from '../src/services/account-deletion.ts';
import { exportAccountData } from '../src/services/data-export.ts';
import { purgeExpiredRecords } from '../src/services/retention.ts';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'GDPR: audit retention, reserved invitation addresses and support export on PostgreSQL',
  () => {
    const schema = `admin_gdpr_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const run = async (sql: string, values: unknown[] = []) =>
      (await pool.query<Record<string, unknown>>(sql, values)).rows;
    let owner: string;
    let customer: string;

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
    });
    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    beforeEach(async () => {
      for (const key of [
        'PRESSAY_RETENTION_AUDIT_READ_DAYS',
        'PRESSAY_RETENTION_AUDIT_ACTION_DAYS',
      ])
        Reflect.deleteProperty(process.env, key);
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_INTERNAL_JWT_SECRET =
        'local-operations-test-key-32-characters';
      process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
      process.env.RATE_LIMIT_HMAC_SECRET = 'local-rate-limit-test-key-32-characters';
      process.env.PRESSAY_OPERATIONS_OWNER_EMAILS = 'owner@example.com';
      clearEnvironmentCacheForTests();
      deleteStripeCustomer.mockReset();
      deleteWebIdentity.mockReset();
      deleteWebIdentity.mockResolvedValue('deleted');
      await run(
        'TRUNCATE "user",pressay_account,operations_owner,operations_audit,access_campaign,waitlist_entry CASCADE',
      );
      owner = await account('owner@example.com');
      customer = await account('Person@Example.test');
    });

    async function account(email: string) {
      const id = randomUUID();
      await run('INSERT INTO pressay_account(id,auth_user_id) VALUES($1::uuid,$2)', [
        id,
        `subject-${id}`,
      ]);
      await run('INSERT INTO entitlement(account_id) VALUES($1)', [id]);
      await run('INSERT INTO account_contact(account_id,email) VALUES($1,$2)', [
        id,
        email,
      ]);
      return id;
    }
    async function campaign(
      email: string | null,
      state: { status?: string; expiresIn?: string; redeemed?: boolean } = {},
    ) {
      const id = randomUUID();
      await run(
        `INSERT INTO access_campaign(id,request_key,kind,delivery,secret_hash,code_hint,duration_days,restricted_email,max_redemptions,redemptions,expires_at,status)
        VALUES($1,$2,'access_grant','code',$3,'ABCD',30,$4,1,$5,now()+$6::interval,$7)`,
        [
          id,
          randomUUID(),
          randomBytes(16).toString('hex'),
          email,
          state.redeemed ? 1 : 0,
          state.expiresIn ?? '10 days',
          state.status ?? 'active',
        ],
      );
      return id;
    }
    async function campaigns() {
      return run(
        'SELECT id,restricted_email,status FROM access_campaign ORDER BY created_at,id',
      );
    }
    async function auditEntry(reason: string, age: string, action = 'grant.create') {
      await run(
        `INSERT INTO operations_audit(actor_id,action,target_id,reason,request_id,result,target_account_id,created_at)
        VALUES($1,$2,$3,$4,'req','succeeded',$5,now()-$6::interval)`,
        [owner, action, customer, reason, customer, age],
      );
    }
    async function get(path: string, stepUp = true) {
      const token = await new SignJWT({
        email: 'owner@example.com',
        email_verified: true,
        token_use: 'pressay_web_proxy',
        sid: 'session',
        pressay_step_up_method: 'totp',
        pressay_step_up_at: stepUp ? Math.floor(Date.now() / 1000) : 0,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(`subject-${owner}`)
        .setIssuer('https://press-say.app/internal')
        .setAudience('pressay-api')
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(new TextEncoder().encode(process.env.PRESSAY_INTERNAL_JWT_SECRET));
      return app.request(`/v1/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    }

    it('keeps audit reads one year and actions five years by default, both configurable', async () => {
      await auditEntry('personal_data_read', '300 days', 'admin.user.read');
      await auditEntry('personal_data_read', '400 days', 'admin.user.read');
      await auditEntry('data_export', '400 days', 'admin.export');
      await auditEntry('Beta tester', '1000 days');
      await auditEntry('Beta tester', '1900 days');
      const purged = await purgeExpiredRecords();
      expect(purged).toMatchObject({ auditReads: 2, auditActions: 1 });
      expect(
        await run(
          `SELECT reason,(now()-created_at)>interval '350 days' AS old FROM operations_audit ORDER BY created_at`,
        ),
      ).toEqual([
        { reason: 'Beta tester', old: true },
        { reason: 'personal_data_read', old: false },
      ]);

      process.env.PRESSAY_RETENTION_AUDIT_READ_DAYS = '30';
      process.env.PRESSAY_RETENTION_AUDIT_ACTION_DAYS = '365';
      clearEnvironmentCacheForTests();
      await auditEntry('personal_data_read', '10 days', 'admin.user.read');
      expect(await purgeExpiredRecords()).toMatchObject({
        auditReads: 1,
        auditActions: 1,
      });
      expect(await run('SELECT reason FROM operations_audit')).toEqual([
        { reason: 'personal_data_read' },
      ]);
      // Out-of-range settings are refused rather than silently purging.
      process.env.PRESSAY_RETENTION_AUDIT_ACTION_DAYS = '30';
      clearEnvironmentCacheForTests();
      await expect(purgeExpiredRecords()).rejects.toThrow();
    });

    it('forgets reserved addresses once an invitation can no longer be redeemed', async () => {
      const open = await campaign('someone@example.test');
      const expired = await campaign('a@example.test', { expiresIn: '-1 day' });
      const revoked = await campaign('b@example.test', { status: 'revoked' });
      const redeemed = await campaign('c@example.test', { redeemed: true });
      const unrestricted = await campaign(null, { expiresIn: '-1 day' });
      expect((await purgeExpiredRecords()).restrictedEmails).toBe(3);
      expect(await campaigns()).toEqual(
        expect.arrayContaining([
          { id: open, restricted_email: 'someone@example.test', status: 'active' },
          { id: expired, restricted_email: null, status: 'active' },
          { id: revoked, restricted_email: null, status: 'revoked' },
          { id: redeemed, restricted_email: null, status: 'active' },
          { id: unrestricted, restricted_email: null, status: 'active' },
        ]),
      );
      expect((await purgeExpiredRecords()).restrictedEmails).toBe(0);
    });

    it('revokes and forgets invitations reserved to a deleted account, then erases it', async () => {
      const pending = await campaign('person@example.test');
      const used = await campaign('person@example.test', { redeemed: true });
      const other = await campaign('someone@example.test');
      await run("UPDATE pressay_account SET status='deleting' WHERE id=$1", [customer]);
      await run('INSERT INTO account_deletion_job(account_id) VALUES($1)', [customer]);
      expect(await runAccountDeletionBatch()).toMatchObject({ completed: 1 });
      expect(await campaigns()).toEqual(
        expect.arrayContaining([
          { id: pending, restricted_email: null, status: 'revoked' },
          { id: used, restricted_email: null, status: 'active' },
          { id: other, restricted_email: 'someone@example.test', status: 'active' },
        ]),
      );
      expect(
        await run('SELECT status FROM pressay_account WHERE id=$1', [customer]),
      ).toEqual([{ status: 'deleted' }]);
      // A deleted account has nothing left to export.
      expect((await get(`admin/users/${customer}/export`)).status).toBe(404);
    });

    it('exports an account for an access request after step-up and audits it', async () => {
      await run(
        `INSERT INTO waitlist_entry(email,platform,locale,source,consent_at) VALUES
        ('person@example.test','ios','fr','landing',now()),('other@example.test','windows','en','landing',now())`,
      );
      await campaign('person@example.test');
      await auditEntry('Beta tester', '2 days');
      await auditEntry('personal_data_read', '1 day', 'admin.user.read');
      // The customer's own export lists their waitlists too.
      const own = await exportAccountData(`subject-${customer}`);
      expect(own.waitlists).toEqual([
        expect.objectContaining({ platform: 'ios', locale: 'fr', source: 'landing' }),
      ]);

      const refused = await get(`admin/users/${customer}/export`, false);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: 'step_up_required' },
      });
      for (const path of [
        `admin/users/${customer}/export?include=sessions`,
        'admin/users/not-a-uuid/export',
      ])
        expect((await get(path)).status, path).toBe(422);
      expect((await get(`admin/users/${randomUUID()}/export`)).status).toBe(404);

      const response = await get(`admin/users/${customer}/export?include=identity`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="pressay-account-${customer}.json"`,
      );
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toMatchObject({
        format: 'pressay-cloud-support-export/1',
        identitySubject: `subject-${customer}`,
        account: { id: customer, status: 'active' },
        contact: { email: 'Person@Example.test' },
        waitlists: [expect.objectContaining({ platform: 'ios' })],
        reservedInvitations: [
          expect.objectContaining({
            kind: 'access_grant',
            status: 'active',
            redeemed: false,
          }),
        ],
      });
      // Support actions are listed, reads (including this export) are not.
      expect(data.supportActions).toEqual([
        expect.objectContaining({ action: 'grant.create', reason: 'Beta tester' }),
      ]);
      const ledger = await run(
        `SELECT actor_id,action,target_id,target_account_id,reason,details FROM operations_audit
        WHERE action='admin.user.export'`,
      );
      expect(ledger).toEqual([
        {
          actor_id: owner,
          action: 'admin.user.export',
          target_id: customer,
          target_account_id: customer,
          reason: 'data_export',
          details: { siteIdentity: true },
        },
      ]);
    });
  },
);
