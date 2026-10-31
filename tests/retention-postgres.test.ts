import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sqlQuery = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));

import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { purgeExpiredRecords } from '../src/services/retention.ts';
import { bearer, configureTestIdentity } from './helpers/identity.ts';

// Run against an isolated local database, never a deployed database.
describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'retention and data export on PostgreSQL',
  () => {
    const schema = `retention_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const accountId = randomUUID();
    const subject = 'retention-subject';
    let deviceId = '';

    async function run(sql: string, values: unknown[] = []) {
      return (await pool.query<Record<string, unknown>>(sql, values)).rows;
    }

    beforeAll(async () => {
      await run(`CREATE SCHEMA ${schema}`);
      sqlQuery.mockImplementation(async (sql: string, values: unknown[]) =>
        run(sql, values),
      );
      for (const file of (await readdir(new URL('../migrations', import.meta.url)))
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        await run(
          await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
        );
      }
    });

    afterAll(async () => {
      await run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });

    beforeEach(async () => {
      process.env.DATABASE_URL = 'postgresql://example.test/pressay';
      clearEnvironmentCacheForTests();
      configureTestIdentity();
      await run('TRUNCATE "user", pressay_account, provider_event CASCADE');
      await run(
        'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)',
        [subject, 'person@example.com'],
      );
      await run('INSERT INTO pressay_account (id, auth_user_id) VALUES ($1, $2)', [
        accountId,
        subject,
      ]);
      await run('INSERT INTO entitlement (account_id) VALUES ($1)', [accountId]);
      await run('INSERT INTO account_contact (account_id, email) VALUES ($1, $2)', [
        accountId,
        'person@example.com',
      ]);
      const device = await run(
        `INSERT INTO pressay_device (
          account_id, device_identifier_hash, display_name, app_variant, app_version
        ) VALUES ($1, decode(repeat('ab', 32), 'hex'), 'Office Mac', 'direct', '1.0.0')
        RETURNING id`,
        [accountId],
      );
      deviceId = String(device[0]?.id);
    });

    it('purges expired operational records and keeps accounting evidence', async () => {
      // Idempotency: one old and expired, one recent.
      await run(
        `INSERT INTO idempotency_record (
          account_id, scope, idempotency_key, request_hash, state, response_status,
          locked_until, expires_at, created_at
        ) VALUES
          ($1, 'billing', 'old-idempotency-key-0001', decode(repeat('00', 32), 'hex'),
            'completed', 201, now() - interval '40 days', now() - interval '39 days',
            now() - interval '40 days'),
          ($1, 'billing', 'new-idempotency-key-0001', decode(repeat('00', 32), 'hex'),
            'completed', 201, now(), now() + interval '1 day', now())`,
        [accountId],
      );
      // Administrative idempotency keys: one older than 30 days, one recent.
      await run('TRUNCATE operations_request');
      await run(
        `INSERT INTO operations_request (request_key, action, target_id, created_at) VALUES
          (gen_random_uuid(), 'grant.create', 'old', now() - interval '31 days'),
          (gen_random_uuid(), 'grant.create', 'new', now())`,
      );
      // Usage reservations: an old finalized one and an open one.
      const oldPeriod = await run(
        "SELECT date_trunc('month', now() - interval '400 days')::date AS period",
      );
      const currentPeriod = await run(
        "SELECT date_trunc('month', now())::date AS period",
      );
      for (const row of [oldPeriod[0], currentPeriod[0]]) {
        await run(
          'INSERT INTO usage_period (account_id, period_start) VALUES ($1, $2)',
          [accountId, row?.period],
        );
      }
      await run(
        `INSERT INTO usage_reservation (
          account_id, device_id, period_start, kind, units, status, idempotency_key,
          request_hash, expires_at, finalized_at, created_at
        ) VALUES
          ($1, $2, $3, 'cloud_transcription', 10, 'finalized', 'old-reservation-key-0001',
            decode(repeat('00', 32), 'hex'), now() - interval '400 days',
            now() - interval '400 days', now() - interval '400 days'),
          ($1, $2, $4, 'cloud_transcription', 10, 'reserved', 'new-reservation-key-0001',
            decode(repeat('00', 32), 'hex'), now() + interval '1 hour', NULL, now())`,
        [accountId, deviceId, oldPeriod[0]?.period, currentPeriod[0]?.period],
      );
      // Provider events: old without ledger row, old with ledger row, old failed, recent.
      await run(
        `INSERT INTO provider_event (
          provider, provider_event_id, payload_sha256, event_type, provider_occurred_at,
          state, error_code, received_at, processed_at
        ) VALUES
          ('stripe', 'evt_old_plain', decode(repeat('00', 32), 'hex'), 'customer.updated',
            now() - interval '500 days', 'applied', NULL, now() - interval '500 days', now()),
          ('stripe', 'evt_old_invoice', decode(repeat('00', 32), 'hex'), 'invoice.paid',
            now() - interval '500 days', 'applied', NULL, now() - interval '500 days', now()),
          ('stripe', 'evt_old_failed', decode(repeat('00', 32), 'hex'), 'invoice.paid',
            now() - interval '500 days', 'failed', 'internal_error',
            now() - interval '500 days', now()),
          ('apple', 'recent', decode(repeat('00', 32), 'hex'), 'DID_RENEW',
            now(), 'applied', NULL, now(), now())`,
      );
      await run(
        `INSERT INTO billing_financial_event (
          provider, provider_event_id, provider_object_id, account_id, kind, status,
          amount_minor, currency, provider_occurred_at
        ) VALUES ('stripe', 'evt_old_invoice', 'in_old', $1, 'invoice_paid', 'paid',
          999, 'eur', now() - interval '500 days')`,
        [accountId],
      );
      await run(
        `INSERT INTO "session" (id, "expiresAt", token, "updatedAt", "userId") VALUES
          ('expired-session', now() - interval '1 day', 'expired-token', now(), $1)`,
        [subject],
      );

      await expect(purgeExpiredRecords()).resolves.toEqual({
        idempotencyRecords: 1,
        operationsRequests: 1,
        usageReservations: 1,
        providerEvents: 1,
        legacySessions: 1,
        legacyVerifications: 0,
        waitlistEntries: 0,
      });
      expect(await run('SELECT target_id FROM operations_request')).toEqual([
        { target_id: 'new' },
      ]);
      expect(await run('SELECT idempotency_key FROM idempotency_record')).toEqual([
        { idempotency_key: 'new-idempotency-key-0001' },
      ]);
      expect(await run('SELECT status FROM usage_reservation')).toEqual([
        { status: 'reserved' },
      ]);
      expect(
        await run('SELECT provider_event_id FROM provider_event ORDER BY 1'),
      ).toEqual([
        { provider_event_id: 'evt_old_failed' },
        { provider_event_id: 'evt_old_invoice' },
        { provider_event_id: 'recent' },
      ]);
      expect(
        await run('SELECT count(*)::int AS n FROM billing_financial_event'),
      ).toEqual([{ n: 1 }]);
      await expect(purgeExpiredRecords()).resolves.toMatchObject({
        idempotencyRecords: 0,
        providerEvents: 0,
      });
    });

    it('exports the caller data without hashes, keys or provider identifiers', async () => {
      await run(
        `INSERT INTO billing_subscription (
          account_id, provider, provider_subscription_id, provider_product_id, status,
          billing_interval, current_period_starts_at, current_period_ends_at,
          provider_event_occurred_at
        ) VALUES ($1, 'stripe', 'sub_secret_identifier', 'price_x', 'active', 'month',
          now(), now() + interval '30 days', now())`,
        [accountId],
      );

      const response = await app.request('/v1/me/export', {
        headers: await bearer(subject),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        format: 'pressay-cloud-export/1',
        account: { id: accountId, status: 'active' },
        contact: { email: 'person@example.com' },
        entitlement: { tier: 'free' },
        devices: [{ id: deviceId, displayName: 'Office Mac', appVariant: 'direct' }],
        subscriptions: [{ provider: 'stripe', status: 'active', interval: 'month' }],
        encryptedSyncChanges: 0,
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('sub_secret_identifier');
      expect(serialized).not.toContain('abababab');
      expect(serialized).not.toContain(subject);
    });

    it('returns 404 for a caller without an active account', async () => {
      const response = await app.request('/v1/me/export', {
        headers: await bearer('someone-else'),
      });
      expect(response.status).toBe(404);
    });
  },
);
