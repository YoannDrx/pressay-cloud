import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { Environment, Status } from '@apple/app-store-server-library';
import { decodeJwt } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sqlQuery = vi.hoisted(() => vi.fn());
const verifyAppleTransaction = vi.hoisted(() => vi.fn());
const getVerifiedAppleSubscriptionStatuses = vi.hoisted(() => vi.fn());
const verifyAppleNotification = vi.hoisted(() => vi.fn());
const verifyAppleNotificationTransaction = vi.hoisted(() => vi.fn());
// Only these settings differ from the local environment: a real production
// configuration needs every provider secret.
const environmentOverride = vi.hoisted((): { value: Record<string, unknown> } => ({
  value: {},
}));
vi.mock('../src/env.ts', async (importOriginal) => {
  const real = await importOriginal<typeof EnvironmentModule>();
  return {
    ...real,
    getEnvironment: () => ({ ...real.getEnvironment(), ...environmentOverride.value }),
  };
});
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query: sqlQuery }) }));
vi.mock('../src/billing/apple-client.ts', () => ({
  verifyAppleTransaction,
  getVerifiedAppleSubscriptionStatuses,
  verifyAppleNotification,
  verifyAppleNotificationTransaction,
}));

import app from '../src/app.ts';
import type * as EnvironmentModule from '../src/env.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { configureTestJwks, externalAccessToken } from './helpers/identity.ts';

const monthly = 'app.pressay.desktop.mas.pro.monthly';
const annual = 'app.pressay.desktop.mas.pro.annual';
const { privateKey } = generateKeyPairSync('ed25519');
const signingKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** The fields these tests read, whichever route answered. */
interface ApiBody {
  accountId: string;
  device: { id: string };
  devices: unknown[];
  revokedDevices: unknown[];
  entitlement: unknown;
  signedSnapshot: { token: string };
  changes: unknown[];
  error: unknown;
}

/** Every request runs through the real routes and SQL, with an app's OAuth token. */
describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'Pressay for iPhone on PostgreSQL',
  () => {
    const schema = `ios_platform_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let subject: string;

    async function migrations(): Promise<string[]> {
      return (await readdir(new URL('../migrations', import.meta.url)))
        .filter((file) => file.endsWith('.sql'))
        .sort();
    }
    async function runMigration(file: string): Promise<void> {
      await pool.query(
        await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      );
    }

    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      sqlQuery.mockImplementation(
        async (sql: string, values: unknown[]) =>
          (await pool.query<Record<string, unknown>>(sql, values)).rows,
      );
      for (const file of await migrations()) await runMigration(file);
    });
    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });
    beforeEach(async () => {
      process.env.DATABASE_URL = 'postgresql://example.test/test';
      process.env.PRESSAY_DEPLOYMENT_ENV = 'development';
      process.env.DEVICE_IDENTIFIER_HMAC_SECRET =
        'local-device-identifier-test-key-32-characters';
      process.env.RATE_LIMIT_HMAC_SECRET = 'local-rate-limit-test-key-32-characters';
      process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY = signingKey;
      environmentOverride.value = {};
      await configureTestJwks();
      clearEnvironmentCacheForTests();
      await pool.query(
        'TRUNCATE pressay_account,billing_product,provider_event,rate_limit_bucket CASCADE',
      );
      await pool.query(
        `INSERT INTO billing_product(id,provider,provider_product_id,provider_price_id,tier,billing_interval,active)
        VALUES('pro-month','app_store',$1,$1,'pro','month',true),
          ('pro-year','app_store',$2,$2,'pro','year',true)`,
        [monthly, annual],
      );
      subject = `auth-${randomUUID()}`;
      for (const mock of [
        verifyAppleTransaction,
        getVerifiedAppleSubscriptionStatuses,
        verifyAppleNotification,
        verifyAppleNotificationTransaction,
      ])
        mock.mockReset();
    });

    async function api(
      path: string,
      init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
    ) {
      const token = await externalAccessToken({}, { subject });
      const response = await app.request(`/v1/${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...init.headers,
        },
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text ? JSON.parse(text) : null) as ApiBody,
      };
    }
    function bootstrap(
      platform: 'macos' | 'windows' | 'ios',
      deviceIdentifier: string,
      appVariant = platform === 'ios' ? 'app_store_ios' : 'direct',
    ) {
      return api('accounts/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          deviceIdentifier,
          displayName: 'Device',
          appVariant,
          appVersion: '1.0.0',
          platform,
        }),
      });
    }
    function iPhone(suffix = 'iphone') {
      return bootstrap('ios', `pressay-device:${suffix}-000000000000`);
    }
    function mac(suffix = 'mac') {
      return bootstrap('macos', `pressay-device:${suffix}-000000000000`);
    }
    function transaction(accountId: string, overrides: Record<string, unknown> = {}) {
      const now = Date.now();
      return {
        transactionId: '2000000000000001',
        originalTransactionId: '2000000000000000',
        productId: monthly,
        purchaseDate: now,
        originalPurchaseDate: now,
        expiresDate: now + 30 * 86_400_000,
        signedDate: now,
        appAccountToken: accountId,
        price: 7990,
        currency: 'EUR',
        ...overrides,
      };
    }
    /** What the app sends after StoreKit returns a signed transaction. */
    function restorePurchase(
      signed: Record<string, unknown>,
      environment: Environment = Environment.PRODUCTION,
    ) {
      verifyAppleTransaction.mockResolvedValue({ environment, transaction: signed });
      getVerifiedAppleSubscriptionStatuses.mockResolvedValue([
        { transaction: signed, status: Status.ACTIVE },
      ]);
      return api('billing/restore-app-store', {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ signedTransaction: 'x'.repeat(64) }),
      });
    }
    async function entitlementFor(deviceId: string) {
      return api('entitlements', { headers: { 'x-device-id': deviceId } });
    }

    describe('migration 0031', () => {
      it('replays over existing devices and keeps the previous values valid', async () => {
        const { body } = await mac();
        await runMigration('0031_ios_devices.sql');
        await runMigration('0031_ios_devices.sql');
        const rows = await pool.query(
          'SELECT platform,app_variant FROM pressay_device WHERE account_id=$1',
          [body.accountId],
        );
        expect(rows.rows).toEqual([{ platform: 'macos', app_variant: 'direct' }]);
        // The call made by the code currently deployed.
        await expect(
          pool.query(
            `SELECT * FROM bootstrap_pressay_account($1,decode($2,'hex'),'Mac','mas','1.0.0','macos')`,
            [subject, 'ab'.repeat(32)],
          ),
        ).resolves.toBeDefined();
      });

      it('still refuses unknown platforms and variants', async () => {
        for (const [platform, variant] of [
          ['android', 'direct'],
          ['ios', 'play_store'],
        ]) {
          await expect(
            pool.query(
              `SELECT * FROM bootstrap_pressay_account($1,decode($2,'hex'),'X',$3,'1.0.0',$4)`,
              [subject, 'cd'.repeat(32), variant, platform],
            ),
          ).rejects.toMatchObject({ code: '23514' });
        }
      });

      it('runs last, so db:check expects it', async () => {
        expect((await migrations()).at(-1)).toBe('0031_ios_devices.sql');
      });
    });

    describe('device slots', () => {
      it('registers an iPhone and lists it as such', async () => {
        const created = await iPhone();
        expect(created.status).toBe(201);
        const { body } = await api('devices');
        expect(body).toMatchObject({
          limit: 3,
          devices: [
            {
              id: created.body.device.id,
              platform: 'ios',
              appVariant: 'app_store_ios',
            },
          ],
        });
      });

      it('refuses a variant that does not match the platform', async () => {
        expect((await bootstrap('ios', 'pressay-device:a-0000000', 'mas')).status).toBe(
          422,
        );
        expect(
          (await bootstrap('macos', 'pressay-device:b-0000000', 'app_store_ios'))
            .status,
        ).toBe(422);
      });

      it('counts an iPhone as the third device and refuses a fourth', async () => {
        await mac('mac-one');
        await bootstrap('windows', 'pressay-device:pc-000000000000');
        expect((await iPhone()).status).toBe(200);

        for (const fourth of [await mac('mac-two'), await iPhone('second-iphone')]) {
          expect(fourth.status).toBe(409);
          expect(fourth.body.error).toMatchObject({ code: 'device_limit_reached' });
        }
        // The registered iPhone can come back without taking another slot.
        expect((await iPhone()).status).toBe(200);
        expect((await api('devices')).body.devices.length).toBe(3);
      });

      it('refuses a fourth device when the iPhone arrives after three computers', async () => {
        await mac('mac-one');
        await mac('mac-two');
        await mac('mac-three');
        const refused = await iPhone();
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatchObject({ code: 'device_limit_reached' });
      });

      it('restores a revoked iPhone only within the three slots', async () => {
        const id = (await iPhone()).body.device.id;
        expect((await api(`devices/${id}`, { method: 'DELETE' })).status).toBe(204);
        expect((await iPhone()).body.error).toMatchObject({ code: 'device_revoked' });
        const { body } = await api('devices?include=revoked');
        expect(body.revokedDevices).toMatchObject([{ id, platform: 'ios' }]);

        const others = [
          await mac('mac-one'),
          await mac('mac-two'),
          await mac('mac-three'),
        ];
        const restore = () => api(`devices/${id}/restore`, { method: 'POST' });
        expect((await restore()).status).toBe(409);

        await api(`devices/${others[0]?.body.device.id}`, { method: 'DELETE' });
        const restored = await restore();
        expect(restored.status).toBe(200);
        expect(restored.body).toEqual({ restored: true });
      });
    });

    describe('one subscription for Mac and iPhone', () => {
      it('activates Pro on the account from an iPhone purchase, seen by the Mac', async () => {
        const phone = await iPhone();
        const restored = await restorePurchase(transaction(phone.body.accountId));
        expect(restored.status).toBe(200);
        expect(restored.body).toEqual({ restored: true });

        const computer = await mac();
        expect(computer.body.entitlement).toMatchObject({
          tier: 'pro',
          source: 'app_store',
        });
        const signed = await entitlementFor(computer.body.device.id);
        expect(signed.status).toBe(200);
        expect(signed.body.entitlement).toMatchObject({ tier: 'pro' });
      });

      it('shows a Mac purchase on the iPhone, with a snapshot the app accepts', async () => {
        const computer = await mac();
        await restorePurchase(
          transaction(computer.body.accountId, {
            productId: annual,
            price: 69000,
            expiresDate: Date.now() + 365 * 86_400_000,
          }),
        );
        const phone = await iPhone();
        expect(phone.body.entitlement).toMatchObject({
          tier: 'pro',
          source: 'app_store',
        });
        const deviceId = phone.body.device.id;
        const signed = await entitlementFor(deviceId);
        expect(decodeJwt(signed.body.signedSnapshot.token)).toMatchObject({
          tier: 'pro',
          device_id: deviceId,
          aud: expect.arrayContaining(['fr.yodev.pressay']) as unknown,
        });
        expect((await api('billing/status')).body).toMatchObject({
          provider: 'app_store',
          interval: 'year',
          status: 'active',
        });
      });

      it('shows Pro on the iPhone to a Stripe subscriber after sign-in', async () => {
        const web = await api('accounts/web-bootstrap', { method: 'POST' });
        const accountId = web.body.accountId;
        await pool.query(
          `INSERT INTO billing_subscription(account_id,provider,provider_subscription_id,provider_product_id,status,billing_interval,current_period_starts_at,current_period_ends_at,provider_event_occurred_at)
          VALUES($1,'stripe','sub_Ios','price_test','active','month',now(),now()+interval '20 days',now())`,
          [accountId],
        );
        await pool.query('SELECT recompute_pressay_entitlement($1)', [accountId]);

        const phone = await iPhone();
        expect(phone.status).toBe(200);
        expect(phone.body.entitlement).toMatchObject({ tier: 'pro', source: 'stripe' });
        const signed = await entitlementFor(phone.body.device.id);
        expect(signed.body.entitlement).toMatchObject({
          tier: 'pro',
          source: 'stripe',
        });
        expect((await api('billing/status')).body).toMatchObject({
          provider: 'stripe',
          status: 'active',
        });
      });

      it('refuses a purchase owned by another Pressay account even when asked to link', async () => {
        const first = await iPhone();
        await restorePurchase(transaction(first.body.accountId));

        subject = `auth-${randomUUID()}`;
        const second = await iPhone('other-iphone');
        const signed = transaction(first.body.accountId);
        verifyAppleTransaction.mockResolvedValue({
          environment: Environment.PRODUCTION,
          transaction: signed,
        });
        const link = (linkToCurrentAccount?: boolean) =>
          api('billing/restore-app-store', {
            method: 'POST',
            headers: { 'idempotency-key': randomUUID() },
            body: JSON.stringify({
              signedTransaction: 'x'.repeat(64),
              ...(linkToCurrentAccount ? { linkToCurrentAccount } : {}),
            }),
          });
        expect((await link()).body.error).toMatchObject({
          code: 'app_store_account_mismatch',
        });
        expect((await link(true)).body.error).toMatchObject({
          code: 'app_store_purchase_already_linked',
        });
        expect(second.body.entitlement).toMatchObject({ tier: 'free' });
      });

      it('treats the annual trial as Pro without counting it as revenue', async () => {
        const phone = await iPhone();
        const accountId = phone.body.accountId;
        const trial = transaction(accountId, {
          productId: annual,
          expiresDate: Date.now() + 7 * 86_400_000,
          price: 0,
          offerType: 1,
          offerDiscountType: 'FREE_TRIAL',
        });
        expect((await restorePurchase(trial)).status).toBe(200);
        expect((await mac()).body.entitlement).toMatchObject({
          tier: 'pro',
          source: 'app_store',
        });
        expect((await api('billing/status')).body).toMatchObject({
          status: 'trialing',
        });

        // The first renewal is a transaction without an offer.
        const renewal = transaction(accountId, {
          transactionId: '2000000000000002',
          productId: annual,
          expiresDate: Date.now() + 365 * 86_400_000,
          signedDate: Date.now() + 1000,
          price: 69000,
        });
        expect(
          await notify(Environment.PRODUCTION, renewal, 'DID_RENEW'),
        ).toMatchObject({
          status: 200,
          body: { status: 'applied' },
        });
        const rows = await pool.query(
          'SELECT from_status,to_status FROM billing_subscription_transition WHERE account_id=$1 ORDER BY id',
          [accountId],
        );
        expect(rows.rows).toEqual([
          { from_status: null, to_status: 'trialing' },
          { from_status: 'trialing', to_status: 'active' },
        ]);
      });

      /** An App Store Server Notification V2 for the transaction, already verified. */
      async function notify(
        environment: Environment,
        signed: Record<string, unknown>,
        notificationType: string,
      ) {
        verifyAppleNotification.mockResolvedValue({
          environment,
          notification: {
            notificationUUID: randomUUID(),
            notificationType,
            signedDate: signed.signedDate,
            data: { signedTransactionInfo: 'signed', status: Status.ACTIVE },
          },
        });
        verifyAppleNotificationTransaction.mockResolvedValue({ transaction: signed });
        const response = await app.request('/v1/webhooks/apple', {
          method: 'POST',
          body: JSON.stringify({ signedPayload: 'x'.repeat(64) }),
        });
        return { status: response.status, body: (await response.json()) as object };
      }

      it('applies a production notification for an iPhone purchase to the account', async () => {
        const phone = await iPhone();
        const accountId = phone.body.accountId;
        expect(
          await notify(Environment.PRODUCTION, transaction(accountId), 'SUBSCRIBED'),
        ).toMatchObject({ status: 200, body: { status: 'applied' } });
        expect((await mac()).body.entitlement).toMatchObject({ tier: 'pro' });
      });

      it('applies Sandbox notifications only under the production Sandbox policy', async () => {
        const phone = await iPhone();
        const accountId = phone.body.accountId;
        const signed = transaction(accountId);

        environmentOverride.value = {
          PRESSAY_DEPLOYMENT_ENV: 'production',
          APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS: [],
        };
        expect(await notify(Environment.SANDBOX, signed, 'SUBSCRIBED')).toMatchObject({
          status: 200,
          body: { status: 'ignored', code: 'sandbox_account_not_allowed' },
        });
        const free = await pool.query(
          'SELECT tier FROM entitlement WHERE account_id=$1',
          [accountId],
        );
        expect(free.rows).toEqual([{ tier: 'free' }]);

        environmentOverride.value = {
          PRESSAY_DEPLOYMENT_ENV: 'production',
          APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS: [accountId],
        };
        expect(await notify(Environment.SANDBOX, signed, 'SUBSCRIBED')).toMatchObject({
          status: 200,
          body: { status: 'applied' },
        });
        const sandbox = await pool.query(
          'SELECT tier,sandbox FROM entitlement WHERE account_id=$1',
          [accountId],
        );
        expect(sandbox.rows).toEqual([{ tier: 'pro', sandbox: true }]);
      });
    });

    describe('account deletion from the app', () => {
      it('offers an explicit choice while Apple may still bill the customer', async () => {
        const phone = await iPhone();
        const accountId = phone.body.accountId;
        await restorePurchase(transaction(accountId));

        const refused = await api('me', { method: 'DELETE' });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toEqual({
          code: 'apple_subscription_active',
          message: expect.any(String) as unknown,
          manageSubscriptionsUrl: 'https://apps.apple.com/account/subscriptions',
          acknowledgeParameter: 'acknowledgeAppleSubscription',
        });
        const untouched = await pool.query(
          'SELECT status FROM pressay_account WHERE id=$1',
          [accountId],
        );
        expect(untouched.rows).toEqual([{ status: 'active' }]);

        const accepted = await api('me?acknowledgeAppleSubscription=true', {
          method: 'DELETE',
        });
        expect(accepted.status).toBe(202);
        const deleting = await pool.query(
          'SELECT status FROM pressay_account WHERE id=$1',
          [accountId],
        );
        expect(deleting.rows).toEqual([{ status: 'deleting' }]);
      });

      it('also asks during the App Store trial, and not without a subscription', async () => {
        const phone = await iPhone();
        await restorePurchase(
          transaction(phone.body.accountId, {
            productId: annual,
            expiresDate: Date.now() + 7 * 86_400_000,
            price: 0,
            offerType: 1,
            offerDiscountType: 'FREE_TRIAL',
          }),
        );
        expect((await api('me', { method: 'DELETE' })).status).toBe(409);

        subject = `auth-${randomUUID()}`;
        await iPhone('free-iphone');
        expect((await api('me', { method: 'DELETE' })).status).toBe(202);
      });
    });

    describe('Pro routes used by the Mac', () => {
      it('enrols the iPhone in encrypted sync and exchanges changes', async () => {
        const phone = await iPhone();
        await restorePurchase(transaction(phone.body.accountId));
        const deviceId = phone.body.device.id;
        const enrolled = await api('sync/devices/enroll', {
          method: 'POST',
          body: JSON.stringify({
            deviceId,
            publicKey: Buffer.alloc(32, 7).toString('base64'),
            encryptedAccountKey: Buffer.alloc(48, 7).toString('base64'),
          }),
        });
        expect(enrolled.status).toBe(201);
        expect(enrolled.body).toEqual({ status: 'approved' });

        const appended = await api('sync/changes', {
          method: 'POST',
          body: JSON.stringify({
            deviceId,
            changes: [
              {
                objectType: 'dictionary',
                objectId: randomUUID(),
                revision: 1,
                envelope: Buffer.alloc(48, 7).toString('base64'),
              },
            ],
          }),
        });
        expect(appended.status).toBeLessThan(300);
        const changes = await api(`sync/changes?deviceId=${deviceId}&after=0`);
        expect(changes.status).toBe(200);
        expect(changes.body.changes).toMatchObject([
          { objectType: 'dictionary', sourceDeviceId: deviceId },
        ]);
      });

      it('keeps sync reserved to Pro on the iPhone', async () => {
        const phone = await iPhone();
        const enrolled = await api('sync/devices/enroll', {
          method: 'POST',
          body: JSON.stringify({
            deviceId: phone.body.device.id,
            publicKey: Buffer.alloc(32, 7).toString('base64'),
            encryptedAccountKey: Buffer.alloc(48, 7).toString('base64'),
          }),
        });
        expect(enrolled.status).toBe(403);
      });
    });
  },
);
