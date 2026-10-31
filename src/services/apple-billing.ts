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
import { getEnvironment } from '../env.js';
import { ApiError, stableErrorCode } from '../lib/errors.js';
import { writeLog } from '../lib/logger.js';
import {
  getVerifiedAppleSubscriptionStatuses,
  verifyAppleNotification,
  verifyAppleNotificationTransaction,
  verifyAppleTransaction,
} from '../billing/apple-client.js';
import {
  IGNORED_PROVIDER_EVENT_CONFLICT,
  RETRYABLE_PROVIDER_EVENT_CONFLICT,
  recordFailedProviderEvent,
} from './provider-events.js';

const transactionSchema = z.object({
  transactionId: z.string().min(1).max(255),
  originalTransactionId: z.string().min(1).max(255),
  productId: z.string().min(1).max(255),
  purchaseDate: z.number().int().positive(),
  originalPurchaseDate: z.number().int().positive().optional(),
  expiresDate: z.number().int().positive(),
  signedDate: z.number().int().positive(),
  // Absent for offer codes redeemed in the App Store, Family Sharing and
  // purchases made outside the app. Such purchases are linked explicitly.
  appAccountToken: z.uuid().optional(),
  revocationDate: z.number().int().positive().optional(),
  isUpgraded: z.boolean().optional(),
});

type AppleTransaction = z.infer<typeof transactionSchema>;
type AppleEnvironment = Environment.PRODUCTION | Environment.SANDBOX;

interface AppleProduct {
  productId: string;
  interval: BillingInterval;
}

type AppleSubscriptionStatus = 'active' | 'past_due' | 'grace' | 'expired' | 'refunded';

interface AppleSubscriptionRecord {
  environment: AppleEnvironment;
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

export interface AppleWebhookResult {
  duplicateOrIgnored: boolean;
  /** Stable reason when the notification was recorded but not applied. */
  code?: string;
}

function parseTransaction(transaction: JWSTransactionDecodedPayload): AppleTransaction {
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
  transaction: AppleTransaction,
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
  transaction: AppleTransaction,
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

function storedSubscriptionId(
  environment: AppleEnvironment,
  originalTransactionId: string,
): string {
  return environment === Environment.SANDBOX
    ? `sandbox/${originalTransactionId}`
    : originalTransactionId;
}

/**
 * Sandbox purchases are free. Production accepts them only because App Review
 * buys in the Sandbox against the production API. To keep a public TestFlight
 * build (or anyone else holding a Sandbox account) from obtaining lasting Pro:
 * - only accounts on APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS receive anything, and
 *   an empty list grants nothing (fail closed);
 * - access ends at the earlier of Apple's expiry and the first Sandbox
 *   purchase + APPLE_SANDBOX_MAX_GRANT_HOURS, so renewals cannot extend it;
 * - the entitlement is marked sandbox, never receives offline grace and never
 *   unlocks paid Cloud services (see cloud-access.ts).
 */
function applySandboxPolicy(
  environment: AppleEnvironment,
  accountId: string,
  transaction: AppleTransaction,
  periodEndsAtMs: number,
): { allowed: true; periodEndsAtMs: number } | { allowed: false } {
  const settings = getEnvironment();
  if (
    environment !== Environment.SANDBOX ||
    settings.PRESSAY_DEPLOYMENT_ENV !== 'production'
  ) {
    return { allowed: true, periodEndsAtMs };
  }
  const allowlist = settings.APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS;
  if (!allowlist.includes(accountId.toLowerCase())) {
    writeLog('warn', 'billing.apple_sandbox_rejected', {
      code: 'sandbox_account_not_allowed',
    });
    return { allowed: false };
  }
  const firstPurchase = transaction.originalPurchaseDate ?? transaction.purchaseDate;
  const capped = Math.min(
    periodEndsAtMs,
    firstPurchase + settings.APPLE_SANDBOX_MAX_GRANT_HOURS * 3_600_000,
  );
  writeLog('warn', 'billing.apple_sandbox_grant', {
    capped: capped < periodEndsAtMs,
    max_hours: settings.APPLE_SANDBOX_MAX_GRANT_HOURS,
  });
  return { allowed: true, periodEndsAtMs: capped };
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

/** Returns the finalized event state and, when not applied, a stable reason. */
async function applyAppleSubscription(
  record: AppleSubscriptionRecord,
): Promise<{ state: string; errorCode: string | null }> {
  let rows: Record<string, unknown>[];
  try {
    rows = await getSql().query(
      `WITH incoming AS (
        INSERT INTO provider_event (
          provider, provider_event_id, payload_sha256, event_type, provider_occurred_at
        ) VALUES ('apple', $1, decode($2, 'hex'), $3, to_timestamp($4 / 1000.0))
        ${RETRYABLE_PROVIDER_EVENT_CONFLICT}
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
        EXISTS (SELECT 1 FROM subscription_upsert),
        CASE
          WHEN EXISTS (SELECT 1 FROM subscription_upsert) THEN NULL
          WHEN $13 = 'Production'
            AND EXISTS (SELECT 1 FROM incoming)
            AND NOT EXISTS (SELECT 1 FROM customer_upsert)
            THEN 'apple_customer_conflict'
          WHEN EXISTS (
            SELECT 1 FROM billing_subscription other
            WHERE other.provider = 'app_store'
              AND other.provider_subscription_id = $6
              AND other.account_id <> $5
          ) THEN 'app_store_purchase_already_linked'
          ELSE NULL
        END
      ) AS state`,
      [
        record.eventId,
        record.payloadHash,
        record.eventType,
        record.eventOccurredAtMs,
        record.accountId,
        storedSubscriptionId(record.environment, record.originalTransactionId),
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
  const state = typeof rows[0]?.state === 'string' ? rows[0].state : 'ignored';
  if (state === 'applied') {
    await flagDuplicateWithStripe(record);
    return { state, errorCode: null };
  }
  const errorCode = await getSql().query(
    `SELECT error_code FROM provider_event WHERE provider = 'apple' AND provider_event_id = $1`,
    [record.eventId],
  );
  const code: unknown = errorCode[0]?.error_code;
  return { state, errorCode: typeof code === 'string' ? code : null };
}

/**
 * Apple and Stripe can both bill the same account (for example a Mac App Store
 * purchase while a web subscription runs). Access is not doubled, but support
 * must refund one side: flag the event and log a stable code.
 */
async function flagDuplicateWithStripe(record: AppleSubscriptionRecord): Promise<void> {
  if (
    record.environment !== Environment.PRODUCTION ||
    !['active', 'grace', 'past_due'].includes(record.status)
  ) {
    return;
  }
  const rows = await getSql().query(
    `UPDATE provider_event
    SET error_code = 'duplicate_subscription_stripe_active'
    WHERE provider = 'apple' AND provider_event_id = $1 AND error_code IS NULL
      AND EXISTS (
        SELECT 1 FROM billing_subscription stripe_subscription
        WHERE stripe_subscription.account_id = $2
          AND stripe_subscription.provider = 'stripe'
          AND stripe_subscription.status IN ('trialing', 'active', 'past_due', 'grace')
          AND stripe_subscription.current_period_ends_at > now()
      )
    RETURNING 1`,
    [record.eventId, record.accountId],
  );
  if (rows.length > 0) {
    writeLog('warn', 'billing.duplicate_subscription', {
      provider: 'apple',
      code: 'duplicate_subscription_stripe_active',
    });
  }
}

async function recordIgnoredAppleEvent(
  eventId: string,
  payloadHash: string,
  eventType: string,
  occurredAtMs: number,
  errorCode: string | null = null,
): Promise<void> {
  await getSql().query(
    `INSERT INTO provider_event (
      provider, provider_event_id, payload_sha256, event_type,
      provider_occurred_at, state, error_code, processed_at
    ) VALUES (
      'apple', $1, decode($2, 'hex'), $3, to_timestamp($4 / 1000.0), 'ignored', $5, now()
    )
    ${IGNORED_PROVIDER_EVENT_CONFLICT}`,
    [eventId, payloadHash, eventType, occurredAtMs, errorCode],
  );
}

/** Account that already owns this App Store subscription, if any. */
async function existingSubscriptionOwner(
  environment: AppleEnvironment,
  originalTransactionId: string,
): Promise<string | undefined> {
  const rows = await getSql().query(
    `SELECT subscription.account_id
    FROM billing_subscription subscription
    WHERE subscription.provider = 'app_store'
      AND subscription.provider_subscription_id = $1
    UNION
    SELECT customer.account_id
    FROM billing_customer customer
    WHERE $2 = 'Production' AND customer.app_store_original_transaction_id = $3`,
    [
      storedSubscriptionId(environment, originalTransactionId),
      environment,
      originalTransactionId,
    ],
  );
  const owner = z.object({ account_id: z.uuid() }).safeParse(rows[0]);
  return owner.success ? owner.data.account_id : undefined;
}

export async function restoreAppStorePurchase(
  authUserId: string,
  signedTransaction: string,
  idempotencyKey: string,
  options: { linkToCurrentAccount?: boolean } = {},
): Promise<{ restored: boolean }> {
  const context = await getAccountProducts(authUserId);
  const payloadHash = createHash('sha256').update(signedTransaction).digest('hex');
  const eventId = `restore/${context.accountId}/${createHash('sha256')
    .update(idempotencyKey)
    .digest('hex')}`;
  const existing = await getSql().query(
    `SELECT encode(payload_sha256, 'hex') AS payload_hash, state
    FROM provider_event WHERE provider = 'apple' AND provider_event_id = $1`,
    [eventId],
  );
  const previous = z
    .object({ payload_hash: z.string(), state: z.string() })
    .safeParse(existing[0]);
  if (previous.success && previous.data.state !== 'failed') {
    if (previous.data.payload_hash !== payloadHash) {
      throw new ApiError(
        409,
        'idempotency_conflict',
        'Idempotency key was used for another transaction',
      );
    }
    return { restored: previous.data.state === 'applied' };
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
  const boundToAccount = initial.appAccountToken === context.accountId;
  if (!boundToAccount) {
    // A purchase made under another Pressay account, another Apple ID flow, or
    // without an account token: only an explicit, confirmed link may attach it,
    // and only while no other Pressay account owns it.
    if (!options.linkToCurrentAccount) {
      throw new ApiError(
        403,
        initial.appAccountToken
          ? 'app_store_account_mismatch'
          : 'app_store_account_token_missing',
        'Confirm that this App Store purchase should be linked to this Pressay account',
        {},
        { linkParameter: 'linkToCurrentAccount' },
      );
    }
    const owner = await existingSubscriptionOwner(
      verified.environment,
      initial.originalTransactionId,
    );
    if (owner && owner !== context.accountId) {
      throw new ApiError(
        409,
        'app_store_purchase_already_linked',
        'This App Store purchase is linked to another Pressay account',
      );
    }
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
          transaction.originalTransactionId !== initial.originalTransactionId ||
          (boundToAccount && transaction.appAccountToken !== context.accountId)
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
  const policy = applySandboxPolicy(
    verified.environment,
    context.accountId,
    current.transaction,
    effectivePeriodEnd(current.transaction, current.status, current.renewal),
  );
  if (!policy.allowed) {
    throw new ApiError(
      403,
      'app_store_sandbox_not_allowed',
      'Sandbox purchases are not accepted for this account',
    );
  }
  const result = await applyAppleSubscription({
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
    periodEndsAtMs: policy.periodEndsAtMs,
    cancelAtPeriodEnd: cancelAtPeriodEnd(current.renewal),
  });
  if (result.errorCode === 'apple_customer_conflict') {
    throw new ApiError(
      409,
      'apple_customer_conflict',
      'Another Apple ID subscription is already linked to this Pressay account',
    );
  }
  if (result.errorCode === 'app_store_purchase_already_linked') {
    throw new ApiError(
      409,
      'app_store_purchase_already_linked',
      'This App Store purchase is linked to another Pressay account',
    );
  }
  if (!boundToAccount) {
    writeLog('info', 'billing.apple_purchase_linked', {
      outcome: result.state,
    });
  }
  return { restored: true };
}

async function resolveWebhookTarget(
  environment: AppleEnvironment,
  transaction: AppleTransaction,
): Promise<{ accountId: string; product: AppleProduct } | { code: string }> {
  const productRows = await getSql().query(
    `SELECT provider_price_id, billing_interval
    FROM billing_product
    WHERE provider = 'app_store' AND provider_price_id = $1 AND active = true`,
    [transaction.productId],
  );
  const productRow = z
    .object({
      provider_price_id: z.string(),
      billing_interval: z.enum(['month', 'year']),
    })
    .safeParse(productRows[0]);
  if (!productRow.success) return { code: 'unknown_app_store_product' };

  // The account that already owns the subscription wins (explicit links and
  // purchases whose renewals arrive without a token); otherwise the token.
  const accountRows = await getSql().query(
    `SELECT account.id AS account_id, 1 AS priority
    FROM billing_subscription subscription
    JOIN pressay_account account ON account.id = subscription.account_id
    WHERE subscription.provider = 'app_store'
      AND subscription.provider_subscription_id = $1
      AND account.status = 'active'
    UNION ALL
    SELECT account.id AS account_id, 2 AS priority
    FROM pressay_account account
    WHERE $2::text IS NOT NULL
      AND account.status = 'active'
      AND account.id = $2::uuid
    ORDER BY priority
    LIMIT 1`,
    [
      storedSubscriptionId(environment, transaction.originalTransactionId),
      transaction.appAccountToken ?? null,
    ],
  );
  const account = z.object({ account_id: z.uuid() }).safeParse(accountRows[0]);
  if (!account.success) {
    return {
      code: transaction.appAccountToken
        ? 'app_account_not_found'
        : 'missing_app_account_token',
    };
  }
  return {
    accountId: account.data.account_id,
    product: {
      productId: productRow.data.provider_price_id,
      interval: productRow.data.billing_interval,
    },
  };
}

export async function processAppleWebhook(
  rawBody: string,
): Promise<AppleWebhookResult> {
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
  const ignore = async (code: string | null): Promise<AppleWebhookResult> => {
    await recordIgnoredAppleEvent(
      eventId,
      payloadHash,
      eventType.data,
      occurredAt.data,
      code,
    );
    if (code) writeLog('warn', 'billing.apple_notification_ignored', { code });
    return { duplicateOrIgnored: true, ...(code ? { code } : {}) };
  };

  try {
    const signedTransaction = notification.data?.signedTransactionInfo;
    if (!signedTransaction) return await ignore(null);

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
    const parsedTransaction = transactionSchema.safeParse(decoded.transaction);
    if (!parsedTransaction.success)
      return await ignore('invalid_app_store_transaction');
    const transaction = parsedTransaction.data;
    const target = await resolveWebhookTarget(verified.environment, transaction);
    if ('code' in target) return await ignore(target.code);

    const status = mapAppleStatus(notification.data?.status, transaction);
    const policy = applySandboxPolicy(
      verified.environment,
      target.accountId,
      transaction,
      effectivePeriodEnd(transaction, status, decoded.renewal),
    );
    if (!policy.allowed) return await ignore('sandbox_account_not_allowed');

    let result;
    try {
      result = await applyAppleSubscription({
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
        periodEndsAtMs: policy.periodEndsAtMs,
        cancelAtPeriodEnd: cancelAtPeriodEnd(decoded.renewal),
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'app_store_purchase_already_linked'
      ) {
        return await ignore(error.code);
      }
      throw error;
    }
    if (result.state !== 'applied') {
      return {
        duplicateOrIgnored: true,
        ...(result.errorCode ? { code: result.errorCode } : {}),
      };
    }
    return { duplicateOrIgnored: false };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
    await recordFailedProviderEvent({
      provider: 'apple',
      eventId,
      payloadHash,
      eventType: eventType.data,
      occurredAtMs: occurredAt.data,
      errorCode: stableErrorCode(error),
    });
    throw error;
  }
}
