import { createHash } from 'node:crypto';

import {
  AutoRenewStatus,
  Environment,
  Status,
  type JWSTransactionDecodedPayload,
  type JWSRenewalInfoDecodedPayload,
} from '@apple/app-store-server-library';
import { z } from 'zod';

import type { BillingInterval } from '../contracts/billing.js';
import { getSql } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import {
  getVerifiedAppleSubscriptionStatuses,
  verifyAppleNotification,
  verifyAppleNotificationTransaction,
  verifyAppleTransaction,
} from '../billing/apple-client.js';

const transactionSchema = z.object({
  transactionId: z.string().min(1).max(255),
  originalTransactionId: z.string().min(1).max(255),
  productId: z.string().min(1).max(255),
  purchaseDate: z.number().int().positive(),
  expiresDate: z.number().int().positive(),
  signedDate: z.number().int().positive(),
  appAccountToken: z.uuid(),
  revocationDate: z.number().int().positive().optional(),
  isUpgraded: z.boolean().optional(),
});

interface AppleProduct {
  productId: string;
  interval: BillingInterval;
}

type AppleSubscriptionStatus = 'active' | 'past_due' | 'grace' | 'expired' | 'refunded';

interface AppleSubscriptionRecord {
  environment: Environment.PRODUCTION | Environment.SANDBOX;
  accountId: string;
  eventId: string;
  payloadHash: string;
  eventType: string;
  eventOccurredAtMs: number;
  originalTransactionId: string;
  productId: string;
  interval: BillingInterval;
  status: AppleSubscriptionStatus;
  periodStartsAtMs: number;
  periodEndsAtMs: number;
  cancelAtPeriodEnd: boolean;
}

function parseTransaction(transaction: JWSTransactionDecodedPayload) {
  const parsed = transactionSchema.safeParse(transaction);
  if (!parsed.success) {
    throw new ApiError(
      422,
      'invalid_app_store_transaction',
      'App Store transaction is incomplete',
    );
  }
  return parsed.data;
}

function mapAppleStatus(
  status: Status | number | undefined,
  transaction: ReturnType<typeof parseTransaction>,
): AppleSubscriptionStatus {
  if (transaction.revocationDate) return 'refunded';
  if (transaction.isUpgraded) return 'expired';
  switch (status) {
    case Status.ACTIVE:
      return 'active';
    case Status.BILLING_RETRY:
      return 'past_due';
    case Status.BILLING_GRACE_PERIOD:
      return 'grace';
    case Status.REVOKED:
      return 'refunded';
    default:
      return 'expired';
  }
}

function effectivePeriodEnd(
  transaction: ReturnType<typeof parseTransaction>,
  status: AppleSubscriptionStatus,
  renewal?: JWSRenewalInfoDecodedPayload,
): number {
  if (
    status === 'grace' &&
    renewal?.gracePeriodExpiresDate &&
    renewal.gracePeriodExpiresDate > transaction.expiresDate
  ) {
    return renewal.gracePeriodExpiresDate;
  }
  return transaction.expiresDate;
}

function cancelAtPeriodEnd(renewal?: JWSRenewalInfoDecodedPayload): boolean {
  return renewal?.autoRenewStatus === AutoRenewStatus.OFF;
}

async function getAccountProducts(authUserId: string): Promise<{
  accountId: string;
  products: ReadonlyMap<string, AppleProduct>;
}> {
  const rows = await getSql().query(
    `SELECT account.id AS account_id, product.provider_price_id, product.billing_interval
    FROM pressay_account account
    JOIN billing_product product
      ON product.provider = 'app_store' AND product.active = true
    WHERE account.auth_user_id = $1 AND account.status = 'active'`,
    [authUserId],
  );
  const parsed = z
    .array(
      z.object({
        account_id: z.uuid(),
        provider_price_id: z.string(),
        billing_interval: z.enum(['month', 'year']),
      }),
    )
    .parse(rows);
  const first = parsed[0];
  if (!first) {
    throw new ApiError(
      503,
      'app_store_billing_not_configured',
      'App Store billing is not configured',
    );
  }
  return {
    accountId: first.account_id,
    products: new Map(
      parsed.map((row) => [
        row.provider_price_id,
        { productId: row.provider_price_id, interval: row.billing_interval },
      ]),
    ),
  };
}

async function applyAppleSubscription(record: AppleSubscriptionRecord): Promise<void> {
  try {
    await getSql().query(
      `WITH incoming AS (
        INSERT INTO provider_event (
          provider, provider_event_id, payload_sha256, event_type, provider_occurred_at
        ) VALUES ('apple', $1, decode($2, 'hex'), $3, to_timestamp($4 / 1000.0))
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        RETURNING provider_event_id
      ), customer_upsert AS (
        INSERT INTO billing_customer (account_id, app_store_original_transaction_id)
        SELECT $5, $6 FROM incoming WHERE $13 = 'Production'
        ON CONFLICT (account_id) DO UPDATE SET
          app_store_original_transaction_id = COALESCE(
            billing_customer.app_store_original_transaction_id,
            EXCLUDED.app_store_original_transaction_id
          ),
          updated_at = now()
        WHERE billing_customer.app_store_original_transaction_id IS NULL
          OR billing_customer.app_store_original_transaction_id = EXCLUDED.app_store_original_transaction_id
        RETURNING account_id
      ), eligible_account AS (
        SELECT account_id FROM customer_upsert
        UNION ALL
        SELECT $5::uuid FROM incoming WHERE $13 = 'Sandbox'
      ), subscription_upsert AS (
        INSERT INTO billing_subscription (
          account_id, provider, provider_subscription_id, provider_product_id,
          status, billing_interval, current_period_starts_at,
          current_period_ends_at, cancel_at_period_end, provider_event_occurred_at, apple_environment
        )
        SELECT
          $5, 'app_store', $6, $7, $8, $9,
          to_timestamp($10 / 1000.0), to_timestamp($11 / 1000.0),
          $12, to_timestamp($4 / 1000.0), $13
        FROM eligible_account
        ON CONFLICT (provider, provider_subscription_id) DO UPDATE SET
          provider_product_id = EXCLUDED.provider_product_id,
          status = EXCLUDED.status,
          billing_interval = EXCLUDED.billing_interval,
          current_period_starts_at = EXCLUDED.current_period_starts_at,
          current_period_ends_at = EXCLUDED.current_period_ends_at,
          cancel_at_period_end = EXCLUDED.cancel_at_period_end,
          provider_event_occurred_at = EXCLUDED.provider_event_occurred_at,
          updated_at = now()
        WHERE billing_subscription.account_id = EXCLUDED.account_id
          AND billing_subscription.apple_environment = EXCLUDED.apple_environment
          AND billing_subscription.provider_event_occurred_at <= EXCLUDED.provider_event_occurred_at
        RETURNING account_id
      )
      SELECT finalize_pressay_billing_event(
        'apple', $1, ARRAY(SELECT account_id FROM subscription_upsert),
        EXISTS (SELECT 1 FROM subscription_upsert), NULL
      ) AS state`,
      [
        record.eventId,
        record.payloadHash,
        record.eventType,
        record.eventOccurredAtMs,
        record.accountId,
        record.environment === Environment.SANDBOX
          ? `sandbox/${record.originalTransactionId}`
          : record.originalTransactionId,
        record.productId,
        record.status,
        record.interval,
        record.periodStartsAtMs,
        record.periodEndsAtMs,
        record.cancelAtPeriodEnd,
        record.environment,
      ],
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new ApiError(
        409,
        'app_store_purchase_already_linked',
        'This App Store purchase is linked to another Pressay account',
      );
    }
    throw error;
  }
}

async function recordIgnoredAppleEvent(
  eventId: string,
  payloadHash: string,
  eventType: string,
  occurredAtMs: number,
): Promise<void> {
  await getSql().query(
    `INSERT INTO provider_event (
      provider, provider_event_id, payload_sha256, event_type,
      provider_occurred_at, state, processed_at
    ) VALUES ('apple', $1, decode($2, 'hex'), $3, to_timestamp($4 / 1000.0), 'ignored', now())
    ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    [eventId, payloadHash, eventType, occurredAtMs],
  );
}

export async function restoreAppStorePurchase(
  authUserId: string,
  signedTransaction: string,
  idempotencyKey: string,
): Promise<{ restored: boolean }> {
  const context = await getAccountProducts(authUserId);
  const payloadHash = createHash('sha256').update(signedTransaction).digest('hex');
  const eventId = `restore/${context.accountId}/${createHash('sha256')
    .update(idempotencyKey)
    .digest('hex')}`;
  const existing = await getSql().query(
    `SELECT encode(payload_sha256, 'hex') AS payload_hash
    FROM provider_event WHERE provider = 'apple' AND provider_event_id = $1`,
    [eventId],
  );
  const previous = z.object({ payload_hash: z.string() }).safeParse(existing[0]);
  if (previous.success) {
    if (previous.data.payload_hash !== payloadHash) {
      throw new ApiError(
        409,
        'idempotency_conflict',
        'Idempotency key was used for another transaction',
      );
    }
    return { restored: true };
  }

  let verified;
  try {
    verified = await verifyAppleTransaction(signedTransaction);
  } catch {
    throw new ApiError(
      401,
      'invalid_app_store_transaction',
      'App Store transaction verification failed',
    );
  }
  const initial = parseTransaction(verified.transaction);
  if (initial.appAccountToken !== context.accountId) {
    throw new ApiError(
      403,
      'app_store_account_mismatch',
      'The App Store purchase belongs to another Pressay account',
    );
  }
  if (!context.products.has(initial.productId)) {
    throw new ApiError(422, 'unknown_app_store_product', 'Unknown App Store product');
  }

  let statuses;
  try {
    statuses = await getVerifiedAppleSubscriptionStatuses(
      initial.transactionId,
      verified.environment,
    );
  } catch {
    throw new ApiError(
      503,
      'app_store_status_unavailable',
      'App Store subscription status is unavailable',
    );
  }
  const candidates = statuses
    .map((item) => {
      try {
        const transaction = parseTransaction(item.transaction);
        const product = context.products.get(transaction.productId);
        if (
          !product ||
          transaction.appAccountToken !== context.accountId ||
          transaction.originalTransactionId !== initial.originalTransactionId
        ) {
          return undefined;
        }
        const status = mapAppleStatus(item.status, transaction);
        return { transaction, product, status, renewal: item.renewal };
      } catch {
        return undefined;
      }
    })
    .filter((candidate) => candidate !== undefined)
    .sort(
      (left, right) =>
        effectivePeriodEnd(right.transaction, right.status, right.renewal) -
        effectivePeriodEnd(left.transaction, left.status, left.renewal),
    );
  const current = candidates[0];
  if (!current) {
    throw new ApiError(
      422,
      'app_store_subscription_not_found',
      'No matching App Store subscription was found',
    );
  }
  await applyAppleSubscription({
    environment: verified.environment,
    accountId: context.accountId,
    eventId,
    payloadHash,
    eventType: 'RESTORE',
    eventOccurredAtMs: current.transaction.signedDate,
    originalTransactionId: current.transaction.originalTransactionId,
    productId: current.transaction.productId,
    interval: current.product.interval,
    status: current.status,
    periodStartsAtMs: current.transaction.purchaseDate,
    periodEndsAtMs: effectivePeriodEnd(
      current.transaction,
      current.status,
      current.renewal,
    ),
    cancelAtPeriodEnd: cancelAtPeriodEnd(current.renewal),
  });
  return { restored: true };
}

async function resolveWebhookTarget(
  appAccountToken: string,
  productId: string,
): Promise<{ accountId: string; product: AppleProduct } | undefined> {
  const productRows = await getSql().query(
    `SELECT provider_price_id, billing_interval
    FROM billing_product
    WHERE provider = 'app_store' AND provider_price_id = $1 AND active = true`,
    [productId],
  );
  const productRow = z
    .object({
      provider_price_id: z.string(),
      billing_interval: z.enum(['month', 'year']),
    })
    .safeParse(productRows[0]);
  if (!productRow.success) return undefined;

  const accountRows = await getSql().query(
    `SELECT DISTINCT account.id AS account_id
    FROM pressay_account account
    WHERE account.status = 'active'
      AND account.id = $1::uuid`,
    [appAccountToken],
  );
  const accounts = z.array(z.object({ account_id: z.uuid() })).parse(accountRows);
  const account = accounts.length === 1 ? accounts[0] : undefined;
  if (!account) return undefined;
  return {
    accountId: account.account_id,
    product: {
      productId: productRow.data.provider_price_id,
      interval: productRow.data.billing_interval,
    },
  };
}

export async function processAppleWebhook(
  rawBody: string,
): Promise<{ duplicateOrIgnored: boolean }> {
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody) as unknown;
  } catch {
    throw new ApiError(422, 'invalid_apple_webhook', 'Invalid Apple webhook');
  }
  const body = z
    .strictObject({ signedPayload: z.string().min(64).max(1_000_000) })
    .safeParse(parsedBody);
  if (!body.success) {
    throw new ApiError(422, 'invalid_apple_webhook', 'Invalid Apple webhook');
  }

  let verified;
  try {
    verified = await verifyAppleNotification(body.data.signedPayload);
  } catch {
    throw new ApiError(401, 'invalid_apple_signature', 'Invalid Apple signature');
  }
  const notification = verified.notification;
  const notificationId = z.uuid().safeParse(notification.notificationUUID);
  const eventType = z.string().min(1).max(160).safeParse(notification.notificationType);
  const occurredAt = z.number().int().positive().safeParse(notification.signedDate);
  if (!notificationId.success || !eventType.success || !occurredAt.success) {
    throw new ApiError(
      422,
      'invalid_apple_notification',
      'Apple notification is incomplete',
    );
  }
  const eventId =
    verified.environment === Environment.SANDBOX
      ? `sandbox/${notificationId.data}`
      : notificationId.data;
  const signedTransaction = notification.data?.signedTransactionInfo;
  if (!signedTransaction) {
    await recordIgnoredAppleEvent(
      eventId,
      payloadHash,
      eventType.data,
      occurredAt.data,
    );
    return { duplicateOrIgnored: true };
  }

  let decoded;
  try {
    decoded = await verifyAppleNotificationTransaction(
      signedTransaction,
      notification.data?.signedRenewalInfo,
      verified.environment,
    );
  } catch {
    throw new ApiError(401, 'invalid_apple_transaction', 'Invalid Apple transaction');
  }
  const transaction = parseTransaction(decoded.transaction);
  const target = await resolveWebhookTarget(
    transaction.appAccountToken,
    transaction.productId,
  );
  if (!target) {
    await recordIgnoredAppleEvent(
      eventId,
      payloadHash,
      eventType.data,
      occurredAt.data,
    );
    return { duplicateOrIgnored: true };
  }
  const status = mapAppleStatus(notification.data?.status, transaction);
  await applyAppleSubscription({
    environment: verified.environment,
    accountId: target.accountId,
    eventId: eventId,
    payloadHash,
    eventType: eventType.data,
    eventOccurredAtMs: occurredAt.data,
    originalTransactionId: transaction.originalTransactionId,
    productId: transaction.productId,
    interval: target.product.interval,
    status,
    periodStartsAtMs: transaction.purchaseDate,
    periodEndsAtMs: effectivePeriodEnd(transaction, status, decoded.renewal),
    cancelAtPeriodEnd: cancelAtPeriodEnd(decoded.renewal),
  });
  return { duplicateOrIgnored: false };
}
