import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Environment, Status } from '@apple/app-store-server-library';

const query = vi.hoisted(() => vi.fn());
const verifyAppleTransaction = vi.hoisted(() => vi.fn());
const getVerifiedAppleSubscriptionStatuses = vi.hoisted(() => vi.fn());
const verifyAppleNotification = vi.hoisted(() => vi.fn());
const verifyAppleNotificationTransaction = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({
  PRESSAY_DEPLOYMENT_ENV: 'development',
  APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS: [] as string[],
  APPLE_SANDBOX_MAX_GRANT_HOURS: 24,
}));

vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));
vi.mock('../src/env.ts', () => ({
  getEnvironment: () => settings,
}));
vi.mock('../src/billing/apple-client.ts', () => ({
  verifyAppleTransaction,
  getVerifiedAppleSubscriptionStatuses,
  verifyAppleNotification,
  verifyAppleNotificationTransaction,
}));

import {
  processAppleWebhook,
  restoreAppStorePurchase,
} from '../src/services/apple-billing.ts';

const accountId = '00000000-0000-4000-8000-000000000001';
const otherAccountId = '00000000-0000-4000-8000-000000000099';
const signedTransaction = `ey.${'a'.repeat(80)}.signature`;
const signedPayload = `ey.${'b'.repeat(80)}.signature`;
const productId = 'app.pressay.pro.monthly';
const baseTransaction = {
  transactionId: '2000000123456789',
  originalTransactionId: '2000000123456000',
  productId,
  purchaseDate: 1_787_000_000_000,
  expiresDate: 1_789_592_000_000,
  signedDate: 1_787_000_001_000,
  appAccountToken: accountId,
};
function transactionWithoutToken(): Omit<typeof baseTransaction, 'appAccountToken'> {
  const copy: Partial<typeof baseTransaction> = { ...baseTransaction };
  delete copy.appAccountToken;
  return copy as Omit<typeof baseTransaction, 'appAccountToken'>;
}
const productRows = [
  { account_id: accountId, provider_price_id: productId, billing_interval: 'month' },
];

function queryParameters(call: number): unknown[] {
  const parameters = (query.mock.calls[call] as [string, unknown[]] | undefined)?.[1];
  return parameters ?? [];
}

function querySql(call: number): string {
  return (query.mock.calls[call] as [string] | undefined)?.[0] ?? '';
}

function mockNotification(
  environment: Environment,
  transaction: Record<string, unknown>,
): void {
  verifyAppleNotification.mockResolvedValue({
    environment,
    notification: {
      notificationUUID: '00000000-0000-4000-8000-000000000006',
      notificationType: 'DID_RENEW',
      signedDate: 1_787_000_002_000,
      data: { status: Status.ACTIVE, signedTransactionInfo: signedTransaction },
    },
  });
  verifyAppleNotificationTransaction.mockResolvedValue({ transaction });
}

describe('App Store billing', () => {
  beforeEach(() => {
    query.mockReset();
    verifyAppleTransaction.mockReset();
    getVerifiedAppleSubscriptionStatuses.mockReset();
    verifyAppleNotification.mockReset();
    verifyAppleNotificationTransaction.mockReset();
    settings.PRESSAY_DEPLOYMENT_ENV = 'development';
    settings.APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS = [];
    settings.APPLE_SANDBOX_MAX_GRANT_HOURS = 24;
  });

  it('restores only a verified server-status subscription bound to the account token', async () => {
    query
      .mockResolvedValueOnce(productRows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    verifyAppleTransaction.mockResolvedValue({
      environment: Environment.SANDBOX,
      transaction: baseTransaction,
    });
    getVerifiedAppleSubscriptionStatuses.mockResolvedValue([
      { status: Status.ACTIVE, transaction: baseTransaction },
    ]);

    await expect(
      restoreAppStorePurchase(
        'auth-user',
        signedTransaction,
        'restore-idempotency-key-0001',
      ),
    ).resolves.toEqual({ restored: true });
    expect(getVerifiedAppleSubscriptionStatuses).toHaveBeenCalledWith(
      baseTransaction.transactionId,
      Environment.SANDBOX,
    );
    // Outside production a Sandbox purchase keeps Apple's own expiry.
    expect(queryParameters(2)[10]).toBe(baseTransaction.expiresDate);
    expect(JSON.stringify(query.mock.calls)).not.toContain(signedTransaction);
  });

  it('asks for confirmation before linking a purchase bound to another Pressay account', async () => {
    query.mockResolvedValueOnce(productRows).mockResolvedValueOnce([]);
    verifyAppleTransaction.mockResolvedValue({
      environment: Environment.SANDBOX,
      transaction: { ...baseTransaction, appAccountToken: otherAccountId },
    });

    await expect(
      restoreAppStorePurchase(
        'auth-user',
        signedTransaction,
        'restore-idempotency-key-0002',
      ),
    ).rejects.toMatchObject({
      status: 403,
      code: 'app_store_account_mismatch',
      details: { linkParameter: 'linkToCurrentAccount' },
    });
    expect(getVerifiedAppleSubscriptionStatuses).not.toHaveBeenCalled();
  });

  it('asks for confirmation when the purchase carries no account token', async () => {
    const withoutToken = transactionWithoutToken();
    query.mockResolvedValueOnce(productRows).mockResolvedValueOnce([]);
    verifyAppleTransaction.mockResolvedValue({
      environment: Environment.PRODUCTION,
      transaction: withoutToken,
    });

    await expect(
      restoreAppStorePurchase(
        'auth-user',
        signedTransaction,
        'restore-idempotency-key-0003',
      ),
    ).rejects.toMatchObject({ status: 403, code: 'app_store_account_token_missing' });
  });

  it('refuses to move a purchase that another Pressay account already owns', async () => {
    query
      .mockResolvedValueOnce(productRows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ account_id: otherAccountId }]);
    verifyAppleTransaction.mockResolvedValue({
      environment: Environment.PRODUCTION,
      transaction: { ...baseTransaction, appAccountToken: otherAccountId },
    });

    await expect(
      restoreAppStorePurchase(
        'auth-user',
        signedTransaction,
        'restore-idempotency-key-0004',
        { linkToCurrentAccount: true },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'app_store_purchase_already_linked' });
    expect(getVerifiedAppleSubscriptionStatuses).not.toHaveBeenCalled();
  });

  it('links a confirmed purchase from another Apple ID flow and flags a running Stripe subscription', async () => {
    const withoutToken = transactionWithoutToken();
    query
      .mockResolvedValueOnce(productRows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ state: 'applied' }])
      .mockResolvedValueOnce([{ '?column?': 1 }]);
    verifyAppleTransaction.mockResolvedValue({
      environment: Environment.PRODUCTION,
      transaction: withoutToken,
    });
    getVerifiedAppleSubscriptionStatuses.mockResolvedValue([
      { status: Status.ACTIVE, transaction: withoutToken },
    ]);

    await expect(
      restoreAppStorePurchase(
        'auth-user',
        signedTransaction,
        'restore-idempotency-key-0005',
        { linkToCurrentAccount: true },
      ),
    ).resolves.toEqual({ restored: true });
    expect(querySql(4)).toContain('duplicate_subscription_stripe_active');
    expect(queryParameters(4)[1]).toBe(accountId);
  });

  it('reports an Apple customer conflict instead of claiming success', async () => {
    query
      .mockResolvedValueOnce(productRows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ state: 'ignored' }])
      .mockResolvedValueOnce([{ error_code: 'apple_customer_conflict' }]);
    verifyAppleTransaction.mockResolvedValue({
      environment: Environment.PRODUCTION,
      transaction: baseTransaction,
    });
    getVerifiedAppleSubscriptionStatuses.mockResolvedValue([
      { status: Status.ACTIVE, transaction: baseTransaction },
    ]);

    await expect(
      restoreAppStorePurchase(
        'auth-user',
        signedTransaction,
        'restore-idempotency-key-0006',
      ),
    ).rejects.toMatchObject({ status: 409, code: 'apple_customer_conflict' });
  });

  it('caps Sandbox access in production to the configured window', async () => {
    settings.PRESSAY_DEPLOYMENT_ENV = 'production';
    settings.APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS = [accountId];
    settings.APPLE_SANDBOX_MAX_GRANT_HOURS = 24;
    query
      .mockResolvedValueOnce(productRows)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    verifyAppleTransaction.mockResolvedValue({
      environment: Environment.SANDBOX,
      transaction: baseTransaction,
    });
    getVerifiedAppleSubscriptionStatuses.mockResolvedValue([
      { status: Status.ACTIVE, transaction: baseTransaction },
    ]);

    await restoreAppStorePurchase(
      'auth-user',
      signedTransaction,
      'restore-idempotency-key-0007',
    );
    expect(queryParameters(2)[10]).toBe(baseTransaction.purchaseDate + 24 * 3_600_000);
    expect(queryParameters(2)[12]).toBe(Environment.SANDBOX);
  });

  it.each([
    ['an empty allowlist', [] as string[]],
    ['an allowlist without the account', [otherAccountId]],
  ])('rejects Sandbox restores in production with %s', async (_, allowlist) => {
    settings.PRESSAY_DEPLOYMENT_ENV = 'production';
    settings.APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS = allowlist;
    query.mockResolvedValueOnce(productRows).mockResolvedValueOnce([]);
    verifyAppleTransaction.mockResolvedValue({
      environment: Environment.SANDBOX,
      transaction: baseTransaction,
    });
    getVerifiedAppleSubscriptionStatuses.mockResolvedValue([
      { status: Status.ACTIVE, transaction: baseTransaction },
    ]);

    await expect(
      restoreAppStorePurchase(
        'auth-user',
        signedTransaction,
        'restore-idempotency-key-0008',
      ),
    ).rejects.toMatchObject({ status: 403, code: 'app_store_sandbox_not_allowed' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('verifies a V2 notification and projects it through unified billing state', async () => {
    mockNotification(Environment.SANDBOX, baseTransaction);
    query
      .mockResolvedValueOnce([
        { provider_price_id: productId, billing_interval: 'month' },
      ])
      .mockResolvedValueOnce([{ account_id: accountId }])
      .mockResolvedValueOnce([{ state: 'applied' }]);

    await expect(
      processAppleWebhook(JSON.stringify({ signedPayload })),
    ).resolves.toEqual({ duplicateOrIgnored: false });
    expect(verifyAppleNotificationTransaction).toHaveBeenCalledWith(
      signedTransaction,
      undefined,
      Environment.SANDBOX,
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain(signedPayload);
  });

  it('records a notification without appAccountToken as ignored with a stable code', async () => {
    const withoutToken = transactionWithoutToken();
    mockNotification(Environment.PRODUCTION, withoutToken);
    query
      .mockResolvedValueOnce([
        { provider_price_id: productId, billing_interval: 'month' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(
      processAppleWebhook(JSON.stringify({ signedPayload })),
    ).resolves.toEqual({ duplicateOrIgnored: true, code: 'missing_app_account_token' });
    expect(querySql(2)).toContain("'ignored'");
    expect(queryParameters(2)[4]).toBe('missing_app_account_token');
    expect(queryParameters(1)[1]).toBeNull();
  });

  it.each([
    ['an empty allowlist', [] as string[]],
    ['an allowlist without the account', [otherAccountId]],
  ])('ignores Sandbox notifications in production with %s', async (_, allowlist) => {
    settings.PRESSAY_DEPLOYMENT_ENV = 'production';
    settings.APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS = allowlist;
    mockNotification(Environment.SANDBOX, baseTransaction);
    query
      .mockResolvedValueOnce([
        { provider_price_id: productId, billing_interval: 'month' },
      ])
      .mockResolvedValueOnce([{ account_id: accountId }])
      .mockResolvedValueOnce([]);

    await expect(
      processAppleWebhook(JSON.stringify({ signedPayload })),
    ).resolves.toEqual({
      duplicateOrIgnored: true,
      code: 'sandbox_account_not_allowed',
    });
    expect(queryParameters(2)[0]).toBe('sandbox/00000000-0000-4000-8000-000000000006');
  });

  it('persists a processing failure with a stable code and rethrows for Apple to retry', async () => {
    mockNotification(Environment.PRODUCTION, baseTransaction);
    query
      .mockResolvedValueOnce([
        { provider_price_id: productId, billing_interval: 'month' },
      ])
      .mockResolvedValueOnce([{ account_id: accountId }])
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: '57014' }))
      .mockResolvedValueOnce([]);

    await expect(
      processAppleWebhook(JSON.stringify({ signedPayload })),
    ).rejects.toThrow('timeout');
    expect(querySql(3)).toContain("'failed'");
    expect(queryParameters(3)[5]).toBe('database_57014');
  });

  it('does not record a failure for an invalid signature', async () => {
    verifyAppleNotification.mockRejectedValue(new Error('bad signature'));

    await expect(
      processAppleWebhook(JSON.stringify({ signedPayload })),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_apple_signature' });
    expect(query).not.toHaveBeenCalled();
  });
});
