import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Environment, Status } from '@apple/app-store-server-library';

const query = vi.hoisted(() => vi.fn());
const verifyAppleTransaction = vi.hoisted(() => vi.fn());
const getVerifiedAppleSubscriptionStatuses = vi.hoisted(() => vi.fn());
const verifyAppleNotification = vi.hoisted(() => vi.fn());
const verifyAppleNotificationTransaction = vi.hoisted(() => vi.fn());

vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
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
const signedTransaction = `ey.${'a'.repeat(80)}.signature`;
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

describe('App Store billing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('restores only a verified server-status subscription bound to the account token', async () => {
    query
      .mockResolvedValueOnce([
        {
          account_id: accountId,
          provider_price_id: productId,
          billing_interval: 'month',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
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
    expect(JSON.stringify(query.mock.calls)).not.toContain(signedTransaction);
  });

  it('rejects a valid purchase bound to another Pressay account', async () => {
    query
      .mockResolvedValueOnce([
        {
          account_id: accountId,
          provider_price_id: productId,
          billing_interval: 'month',
        },
      ])
      .mockResolvedValueOnce([]);
    verifyAppleTransaction.mockResolvedValue({
      environment: Environment.SANDBOX,
      transaction: {
        ...baseTransaction,
        appAccountToken: '00000000-0000-4000-8000-000000000099',
      },
    });

    await expect(
      restoreAppStorePurchase(
        'auth-user',
        signedTransaction,
        'restore-idempotency-key-0002',
      ),
    ).rejects.toMatchObject({ code: 'app_store_account_mismatch' });
    expect(getVerifiedAppleSubscriptionStatuses).not.toHaveBeenCalled();
  });

  it('verifies a V2 notification and projects it through unified billing state', async () => {
    const notificationId = '00000000-0000-4000-8000-000000000006';
    const signedPayload = `ey.${'b'.repeat(80)}.signature`;
    verifyAppleNotification.mockResolvedValue({
      environment: Environment.SANDBOX,
      notification: {
        notificationUUID: notificationId,
        notificationType: 'DID_RENEW',
        signedDate: 1_787_000_002_000,
        data: {
          status: Status.ACTIVE,
          signedTransactionInfo: signedTransaction,
        },
      },
    });
    verifyAppleNotificationTransaction.mockResolvedValue({
      transaction: baseTransaction,
    });
    query
      .mockResolvedValueOnce([
        { provider_price_id: productId, billing_interval: 'month' },
      ])
      .mockResolvedValueOnce([{ account_id: accountId }])
      .mockResolvedValueOnce([]);

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
});
