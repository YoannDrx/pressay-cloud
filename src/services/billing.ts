import { captureReferralEvent } from './referrals.js';
import { createHash, randomUUID } from 'node:crypto';

import type Stripe from 'stripe';
import { z } from 'zod';

import { getStripe } from '../billing/stripe-client.js';
import { billingStatusSchema, type BillingInterval } from '../contracts/billing.js';
import { getSql } from '../db/client.js';
import { getEnvironment } from '../env.js';
import { ApiError, stableErrorCode } from '../lib/errors.js';
import { writeLog } from '../lib/logger.js';
import {
  IGNORED_PROVIDER_EVENT_CONFLICT,
  RETRYABLE_PROVIDER_EVENT_CONFLICT,
  recordFailedProviderEvent,
} from './provider-events.js';

const checkoutContextSchema = z.object({
  account_id: z.uuid(),
  stripe_customer_id: z.string().nullable(),
  provider_price_id: z.string(),
  stripe_subscription_active: z.boolean().default(false),
  apple_subscription_active: z.boolean().default(false),
});

const CHECKOUT_INTEGRATION_IDENTIFIER = 'pressay_direct_v1_vkmrqjtp';

/** Subscription states that still grant (or may soon grant) Pro. */
const LIVE_SUBSCRIPTION_STATUSES = "('trialing', 'active', 'past_due', 'grace')";

/**
 * Stripe subscription states that bill (or will bill again) the customer. A
 * second Checkout for a customer with one of these would create a second
 * subscription, so it is refused even when the webhook has not reached
 * Postgres yet.
 */
const STRIPE_BLOCKING_SUBSCRIPTION_STATUSES: ReadonlySet<Stripe.Subscription.Status> =
  new Set(['active', 'trialing', 'past_due', 'unpaid']);

/**
 * Longer than the 60-second function limit (vercel.json), so a lease is never
 * reclaimed while its request can still create a session, yet short enough
 * that a crashed request does not block the account for long.
 */
const CHECKOUT_LEASE_SECONDS = 90;

/** An open session closer than this to its expiry is replaced, not reused. */
const CHECKOUT_REUSE_MIN_REMAINING_SECONDS = 5 * 60;

function stripeCheckoutIdempotencyKey(accountId: string, clientKey: string): string {
  const digest = createHash('sha256').update(clientKey).digest('hex');
  return `pressay-checkout/${accountId}/${digest}`;
}

function pastDueGraceSeconds(): number {
  return getEnvironment().STRIPE_PAST_DUE_GRACE_DAYS * 86_400;
}

async function getCheckoutContext(authUserId: string, interval: BillingInterval) {
  const rows = await getSql().query(
    `SELECT
      a.id AS account_id,
      customer.stripe_customer_id,
      product.provider_price_id,
      EXISTS (
        SELECT 1 FROM billing_subscription subscription
        WHERE subscription.account_id = a.id
          AND subscription.provider = 'stripe'
          AND subscription.status IN ${LIVE_SUBSCRIPTION_STATUSES}
          AND subscription.current_period_ends_at > now()
      ) AS stripe_subscription_active,
      EXISTS (
        SELECT 1 FROM billing_subscription subscription
        WHERE subscription.account_id = a.id
          AND subscription.provider = 'app_store'
          AND subscription.apple_environment = 'Production'
          AND subscription.status IN ${LIVE_SUBSCRIPTION_STATUSES}
          AND subscription.current_period_ends_at > now()
      ) AS apple_subscription_active
    FROM pressay_account a
    JOIN entitlement e ON e.account_id = a.id
    JOIN billing_product product
      ON product.provider = 'stripe'
      AND product.billing_interval = $2
      AND product.active = true
    LEFT JOIN billing_customer customer ON customer.account_id = a.id
    WHERE a.auth_user_id = $1 AND a.status = 'active'`,
    [authUserId, interval],
  );
  if (!rows[0]) {
    throw new ApiError(503, 'billing_not_configured', 'Billing is not configured');
  }
  return checkoutContextSchema.parse(rows[0]);
}

async function ensureStripeCustomer(
  authUserId: string,
  email: string,
  accountId: string,
  existingCustomerId: string | null,
): Promise<string> {
  if (existingCustomerId) {
    // Keep receipts and invoices addressed to the verified account email.
    await getStripe().customers.update(existingCustomerId, { email });
    return existingCustomerId;
  }
  const customer = await getStripe().customers.create(
    {
      email,
      metadata: { pressay_account_id: accountId, pressay_auth_user_id: authUserId },
    },
    { idempotencyKey: `pressay-customer/${accountId}` },
  );
  await getSql().query(
    `INSERT INTO billing_customer (account_id, stripe_customer_id)
    VALUES ($1, $2)
    ON CONFLICT (account_id) DO UPDATE SET
      stripe_customer_id = COALESCE(billing_customer.stripe_customer_id, EXCLUDED.stripe_customer_id),
      updated_at = now()`,
    [accountId, customer.id],
  );
  return customer.id;
}

function checkoutTaxParameters(): Pick<
  Stripe.Checkout.SessionCreateParams,
  | 'automatic_tax'
  | 'billing_address_collection'
  | 'customer_update'
  | 'tax_id_collection'
> {
  const environment = getEnvironment();
  if (!environment.STRIPE_AUTOMATIC_TAX_ENABLED) return {};
  return {
    automatic_tax: { enabled: true },
    billing_address_collection: 'required',
    // Checkout always runs against an existing customer: save the address
    // (and business name for tax IDs) collected on the page to that customer.
    customer_update: { address: 'auto', name: 'auto' },
    ...(environment.STRIPE_TAX_ID_COLLECTION_ENABLED
      ? { tax_id_collection: { enabled: true } }
      : {}),
  };
}

function checkoutInProgress(): ApiError {
  return new ApiError(
    409,
    'checkout_in_progress',
    'A checkout is already in progress for this account. Try again in a moment.',
  );
}

function subscriptionAlreadyActive(): ApiError {
  return new ApiError(
    409,
    'subscription_already_active',
    'A Pressay subscription is already active. Manage it from the billing portal.',
    {},
    { manage: 'billing_portal' },
  );
}

async function acquireCheckoutLease(accountId: string): Promise<string> {
  const leaseId = randomUUID();
  const rows = await getSql().query(
    `INSERT INTO billing_checkout_lease (account_id, lease_id, expires_at)
    VALUES ($1, $2, now() + make_interval(secs => $3))
    ON CONFLICT (account_id) DO UPDATE SET
      lease_id = EXCLUDED.lease_id,
      expires_at = EXCLUDED.expires_at
    WHERE billing_checkout_lease.expires_at <= now()
    RETURNING lease_id`,
    [accountId, leaseId, CHECKOUT_LEASE_SECONDS],
  );
  if (z.object({ lease_id: z.literal(leaseId) }).safeParse(rows[0]).success) {
    return leaseId;
  }
  throw checkoutInProgress();
}

async function releaseCheckoutLease(accountId: string, leaseId: string): Promise<void> {
  try {
    await getSql().query(
      'DELETE FROM billing_checkout_lease WHERE account_id = $1 AND lease_id = $2',
      [accountId, leaseId],
    );
  } catch (error) {
    // The lease expires on its own; never mask the checkout outcome.
    writeLog('warn', 'billing.checkout_lease_release_failed', {
      code: stableErrorCode(error),
    });
  }
}

/**
 * Stripe is the source of truth for what the customer can still be charged
 * for. Refuse when a billing subscription exists, reuse an open Checkout
 * Session for the same Price, and expire any other open session so the
 * customer never holds two payable sessions at once.
 */
async function reusableCheckoutUrl(
  customerId: string,
  accountId: string,
  priceId: string,
): Promise<string | null> {
  const stripe = getStripe();
  // Without a status filter Stripe lists every subscription except canceled ones.
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    limit: 100,
  });
  if (
    subscriptions.data.some((subscription) =>
      STRIPE_BLOCKING_SUBSCRIPTION_STATUSES.has(subscription.status),
    )
  ) {
    throw subscriptionAlreadyActive();
  }

  const openSessions = await stripe.checkout.sessions.list({
    customer: customerId,
    status: 'open',
    limit: 100,
  });
  const reuseBefore =
    Math.floor(Date.now() / 1000) + CHECKOUT_REUSE_MIN_REMAINING_SECONDS;
  let reusable: string | null = null;
  for (const session of openSessions.data) {
    if (
      reusable === null &&
      session.mode === 'subscription' &&
      session.url &&
      session.metadata?.pressay_account_id === accountId &&
      session.metadata.pressay_price_id === priceId &&
      session.expires_at >= reuseBefore
    ) {
      reusable = session.url;
      continue;
    }
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (error) {
      // Stripe refuses to expire a session that is no longer open, which
      // happens when the customer is completing it right now. Do not create a
      // second session alongside it.
      writeLog('warn', 'billing.checkout_session_expire_failed', {
        code: stableErrorCode(error),
      });
      throw checkoutInProgress();
    }
  }
  return reusable;
}

export async function createCheckout(
  authUserId: string,
  email: string,
  interval: BillingInterval,
  idempotencyKey: string,
  termsVersion: string,
  immediatePerformanceConsent: true,
): Promise<string> {
  const environment = getEnvironment();
  if (!environment.STRIPE_COMMERCIAL_LAUNCH_ENABLED) {
    throw new ApiError(
      503,
      'commercial_launch_not_enabled',
      'Commercial checkout is not enabled',
    );
  }
  const context = await getCheckoutContext(authUserId, interval);
  if (context.stripe_subscription_active) {
    throw subscriptionAlreadyActive();
  }
  if (context.apple_subscription_active) {
    throw new ApiError(
      409,
      'apple_subscription_active',
      'Pressay Pro is already billed through the App Store for this account.',
      {},
      { manageSubscriptionsUrl: 'https://apps.apple.com/account/subscriptions' },
    );
  }
  // Two tabs (or a double submit) must not create two Checkout Sessions, and
  // therefore two subscriptions: one creation at a time per account.
  const leaseId = await acquireCheckoutLease(context.account_id);
  try {
    return await createCheckoutWithLease(
      context,
      authUserId,
      email,
      idempotencyKey,
      termsVersion,
      immediatePerformanceConsent,
    );
  } finally {
    await releaseCheckoutLease(context.account_id, leaseId);
  }
}

async function createCheckoutWithLease(
  context: z.infer<typeof checkoutContextSchema>,
  authUserId: string,
  email: string,
  idempotencyKey: string,
  termsVersion: string,
  immediatePerformanceConsent: true,
): Promise<string> {
  const environment = getEnvironment();
  await getSql().query(
    `INSERT INTO billing_legal_acceptance (
      account_id, checkout_idempotency_key, terms_version,
      immediate_performance_consent
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (account_id, checkout_idempotency_key) DO NOTHING`,
    [context.account_id, idempotencyKey, termsVersion, immediatePerformanceConsent],
  );
  const customerId = await ensureStripeCustomer(
    authUserId,
    email,
    context.account_id,
    context.stripe_customer_id,
  );
  const reusableUrl = await reusableCheckoutUrl(
    customerId,
    context.account_id,
    context.provider_price_id,
  );
  if (reusableUrl) {
    writeLog('info', 'billing.checkout_session_reused', { provider: 'stripe' });
    return reusableUrl;
  }
  const session = await getStripe().checkout.sessions.create(
    {
      mode: 'subscription',
      integration_identifier: CHECKOUT_INTEGRATION_IDENTIFIER,
      customer: customerId,
      line_items: [{ price: context.provider_price_id, quantity: 1 }],
      success_url: environment.STRIPE_CHECKOUT_SUCCESS_URL,
      cancel_url: environment.STRIPE_CHECKOUT_CANCEL_URL,
      allow_promotion_codes: true,
      client_reference_id: context.account_id,
      metadata: {
        pressay_account_id: context.account_id,
        pressay_price_id: context.provider_price_id,
      },
      subscription_data: {
        metadata: { pressay_account_id: context.account_id },
      },
      ...checkoutTaxParameters(),
    },
    {
      idempotencyKey: stripeCheckoutIdempotencyKey(context.account_id, idempotencyKey),
    },
  );
  if (!session.url)
    throw new ApiError(503, 'stripe_session_unavailable', 'Checkout is unavailable');
  return session.url;
}

export async function createBillingPortal(authUserId: string): Promise<string> {
  const rows = await getSql().query(
    `SELECT customer.stripe_customer_id
    FROM pressay_account a
    JOIN billing_customer customer ON customer.account_id = a.id
    WHERE a.auth_user_id = $1 AND a.status = 'active'`,
    [authUserId],
  );
  const customerId = z.object({ stripe_customer_id: z.string() }).safeParse(rows[0]);
  if (!customerId.success) {
    throw new ApiError(404, 'stripe_customer_not_found', 'No Stripe customer exists');
  }
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId.data.stripe_customer_id,
    return_url: getEnvironment().STRIPE_PORTAL_RETURN_URL,
  });
  return session.url;
}

export async function getBillingStatus(authUserId: string) {
  const rows = await getSql().query(
    `SELECT
      subscription.provider,
      subscription.billing_interval,
      subscription.status,
      subscription.current_period_ends_at,
      subscription.cancel_at_period_end
    FROM pressay_account account
    JOIN entitlement ON entitlement.account_id = account.id
    LEFT JOIN LATERAL (
      SELECT
        provider,
        billing_interval,
        status,
        current_period_ends_at,
        cancel_at_period_end
      FROM billing_subscription
      WHERE account_id = account.id
      ORDER BY
        (apple_environment = 'Sandbox') ASC,
        (provider = entitlement.source) DESC,
        provider_event_occurred_at DESC,
        updated_at DESC
      LIMIT 1
    ) subscription ON true
    WHERE account.auth_user_id = $1 AND account.status = 'active'`,
    [authUserId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError(404, 'account_not_found', 'Account not found');
  return billingStatusSchema.parse({
    provider: row.provider ?? null,
    interval: row.billing_interval ?? null,
    status: row.status ?? null,
    currentPeriodEndsAt: row.current_period_ends_at
      ? new Date(row.current_period_ends_at as string).toISOString()
      : null,
    cancelAtPeriodEnd: row.cancel_at_period_end ?? false,
  });
}

function stripeObjectId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function isMissingStripeResource(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'resource_missing'
  );
}

type FinancialEventKind =
  'invoice_paid' | 'invoice_failed' | 'invoice_voided' | 'refund' | 'dispute';

type ProjectedSubscriptionStatus =
  'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'expired' | 'refunded';

interface FinancialProjection {
  providerObjectId: string;
  customerId: string;
  subscriptionId: string | null;
  kind: FinancialEventKind;
  status: string;
  amountMinor: number;
  currency: string;
  fullReversal: boolean;
  subscriptionStatusOverride: ProjectedSubscriptionStatus | null;
  chargeOccurredAt: number | null;
}

async function recordIgnoredStripeEvent(
  event: Stripe.Event,
  payloadHash: string,
  errorCode: string | null,
): Promise<void> {
  await getSql().query(
    `INSERT INTO provider_event (
      provider, provider_event_id, payload_sha256, event_type,
      provider_occurred_at, state, error_code, processed_at
    ) VALUES (
      'stripe', $1, decode($2, 'hex'), $3, to_timestamp($4), 'ignored', $5, now()
    )
    ${IGNORED_PROVIDER_EVENT_CONFLICT}`,
    [event.id, payloadHash, event.type, event.created, errorCode],
  );
}

async function stripeEventAlreadyProcessed(eventId: string): Promise<boolean> {
  const rows = await getSql().query(
    `SELECT 1 FROM provider_event
    WHERE provider = 'stripe' AND provider_event_id = $1
      AND state IN ('applied', 'ignored')`,
    [eventId],
  );
  return rows.length > 0;
}

async function recordStripeFinancialProjection(
  event: Stripe.Event,
  payloadHash: string,
  projection: FinancialProjection,
): Promise<boolean> {
  if (!/^[a-z]{3}$/.test(projection.currency) || projection.amountMinor < 0) {
    return false;
  }
  const rows = await getSql().query(
    `WITH incoming AS (
      INSERT INTO provider_event (
        provider, provider_event_id, payload_sha256, event_type, provider_occurred_at
      ) VALUES ('stripe', $1, decode($2, 'hex'), $3, to_timestamp($4))
      ${RETRYABLE_PROVIDER_EVENT_CONFLICT}
      RETURNING provider_event_id
    ), account_context AS (
      SELECT customer.account_id
      FROM billing_customer customer, incoming
      WHERE customer.stripe_customer_id = $5
    ), financial_insert AS (
      INSERT INTO billing_financial_event (
        provider, provider_event_id, provider_object_id, account_id,
        provider_subscription_id, kind, status, amount_minor, currency,
        full_reversal, provider_occurred_at
      )
      SELECT
        'stripe', $1, $6, account_context.account_id, $7, $8, $9,
        $10, $11, $12, to_timestamp($4)
      FROM account_context
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING account_id
    ), subscription_update AS (
      UPDATE billing_subscription subscription
      SET status = $13,
        grace_ends_at = CASE
          WHEN $13::text = 'past_due' THEN to_timestamp($4) + make_interval(secs => $15)
          ELSE NULL
        END,
        updated_at = now(),
        provider_event_occurred_at = to_timestamp($4)
      FROM financial_insert
      WHERE $13::text IS NOT NULL
        AND subscription.account_id = financial_insert.account_id
        AND subscription.provider = 'stripe'
        AND ($7::text IS NULL OR subscription.provider_subscription_id = $7)
        AND subscription.provider_event_occurred_at <= to_timestamp($4)
        AND (
          $14::bigint IS NULL
          OR subscription.current_period_starts_at IS NULL
          OR to_timestamp($14) >= subscription.current_period_starts_at
        )
      RETURNING subscription.account_id
    )
    SELECT finalize_pressay_billing_event(
      'stripe', $1, ARRAY(SELECT account_id FROM subscription_update),
      EXISTS (SELECT 1 FROM financial_insert),
      CASE WHEN EXISTS (SELECT 1 FROM financial_insert) THEN NULL ELSE 'billing_customer_not_found' END
    ) AS state`,
    [
      event.id,
      payloadHash,
      event.type,
      event.created,
      projection.customerId,
      projection.providerObjectId,
      projection.subscriptionId,
      projection.kind,
      projection.status,
      projection.amountMinor,
      projection.currency,
      projection.fullReversal,
      projection.subscriptionStatusOverride,
      projection.chargeOccurredAt,
      pastDueGraceSeconds(),
    ],
  );
  return rows[0]?.state === 'applied';
}

function invoiceSubscription(
  invoice: Stripe.Invoice,
): string | Stripe.Subscription | null {
  return invoice.parent?.subscription_details?.subscription ?? null;
}

async function processStripeInvoiceEvent(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  payloadHash: string,
): Promise<boolean> {
  const subscriptionReference = invoiceSubscription(invoice);
  if (!subscriptionReference) return false;
  const subscription =
    typeof subscriptionReference === 'string'
      ? await getStripe().subscriptions.retrieve(subscriptionReference)
      : subscriptionReference;
  const customerId = stripeObjectId(invoice.customer);
  const kind: FinancialEventKind =
    event.type === 'invoice.paid'
      ? 'invoice_paid'
      : event.type === 'invoice.voided'
        ? 'invoice_voided'
        : 'invoice_failed';
  // The ledger row is written in the same statement as the subscription
  // projection, so a failure can never mark the event processed without it.
  return applyStripeSubscription(
    event,
    subscription,
    payloadHash,
    customerId && invoice.id
      ? {
          invoiceId: invoice.id,
          kind,
          status: invoice.status ?? event.type,
          amountMinor:
            event.type === 'invoice.paid' ? invoice.amount_paid : invoice.amount_due,
          currency: invoice.currency,
        }
      : undefined,
  );
}

async function resolveCharge(
  charge: string | Stripe.Charge | null,
): Promise<Stripe.Charge | null> {
  if (!charge) return null;
  return typeof charge === 'string' ? getStripe().charges.retrieve(charge) : charge;
}

/**
 * A full refund or a lost dispute must stop future renewals: otherwise the
 * next invoice.paid would silently reactivate and recharge the customer.
 * Cancels the customer's live subscriptions whose current period contains the
 * reversed charge. Safe to repeat.
 */
async function cancelReversedStripeSubscriptions(
  customerId: string,
  chargeCreated: number,
): Promise<void> {
  const rows = await getSql().query(
    `SELECT subscription.provider_subscription_id
    FROM billing_subscription subscription
    JOIN billing_customer customer ON customer.account_id = subscription.account_id
    WHERE customer.stripe_customer_id = $1
      AND subscription.provider = 'stripe'
      AND subscription.status IN ('trialing', 'active', 'past_due', 'grace', 'paused')
      AND (
        subscription.current_period_starts_at IS NULL
        OR to_timestamp($2) >= subscription.current_period_starts_at
      )`,
    [customerId, chargeCreated],
  );
  for (const row of rows) {
    const subscriptionId = String(row.provider_subscription_id);
    try {
      await getStripe().subscriptions.cancel(
        subscriptionId,
        {},
        { idempotencyKey: `pressay-reversal-cancel/${subscriptionId}` },
      );
    } catch (error) {
      if (isMissingStripeResource(error)) continue;
      const current = await getStripe()
        .subscriptions.retrieve(subscriptionId)
        .catch(() => undefined);
      if (current?.status === 'canceled' || current?.status === 'incomplete_expired') {
        continue;
      }
      throw error;
    }
    writeLog('info', 'billing.subscription_cancelled_after_reversal', {
      provider: 'stripe',
    });
  }
}

/** Authoritative Stripe state of the customer's most recent subscription. */
async function currentStripeSubscriptionState(
  customerId: string,
): Promise<{ id: string; status: ProjectedSubscriptionStatus } | null> {
  const rows = await getSql().query(
    `SELECT subscription.provider_subscription_id
    FROM billing_subscription subscription
    JOIN billing_customer customer ON customer.account_id = subscription.account_id
    WHERE customer.stripe_customer_id = $1 AND subscription.provider = 'stripe'
    ORDER BY subscription.provider_event_occurred_at DESC
    LIMIT 1`,
    [customerId],
  );
  const subscriptionId: unknown = rows[0]?.provider_subscription_id;
  if (typeof subscriptionId !== 'string') return null;
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  return { id: subscription.id, status: mapStripeStatus(subscription.status) };
}

async function processStripeFinancialEvent(
  event: Stripe.Event,
  payloadHash: string,
): Promise<boolean | null> {
  if (event.data.object.object === 'charge' && event.type === 'charge.refunded') {
    const charge = event.data.object;
    const customerId = stripeObjectId(charge.customer);
    if (!customerId) return false;
    const fullReversal = charge.amount_refunded >= charge.amount;
    if (fullReversal) {
      if (await stripeEventAlreadyProcessed(event.id)) return false;
      await cancelReversedStripeSubscriptions(customerId, charge.created);
    }
    return recordStripeFinancialProjection(event, payloadHash, {
      providerObjectId: charge.id,
      customerId,
      subscriptionId: null,
      kind: 'refund',
      status: fullReversal ? 'succeeded_full' : 'succeeded_partial',
      amountMinor: charge.amount_refunded,
      currency: charge.currency,
      fullReversal,
      subscriptionStatusOverride: fullReversal ? 'refunded' : null,
      chargeOccurredAt: charge.created,
    });
  }
  if (event.data.object.object === 'refund' && event.type.startsWith('refund.')) {
    const refund = event.data.object;
    const charge = await resolveCharge(refund.charge);
    const customerId = charge ? stripeObjectId(charge.customer) : null;
    if (!charge || !customerId) return false;
    const fullReversal =
      refund.status === 'succeeded' && charge.amount_refunded >= charge.amount;
    if (fullReversal) {
      if (await stripeEventAlreadyProcessed(event.id)) return false;
      await cancelReversedStripeSubscriptions(customerId, charge.created);
    }
    return recordStripeFinancialProjection(event, payloadHash, {
      providerObjectId: refund.id,
      customerId,
      subscriptionId: null,
      kind: 'refund',
      status: refund.status ?? 'unknown',
      amountMinor: refund.amount,
      currency: refund.currency,
      fullReversal,
      subscriptionStatusOverride: fullReversal ? 'refunded' : null,
      chargeOccurredAt: charge.created,
    });
  }
  if (
    event.data.object.object === 'dispute' &&
    event.type.startsWith('charge.dispute.')
  ) {
    const dispute = event.data.object;
    const charge = await resolveCharge(dispute.charge);
    const customerId = charge ? stripeObjectId(charge.customer) : null;
    if (!charge || !customerId) return false;
    let override: ProjectedSubscriptionStatus | null;
    let subscriptionId: string | null = null;
    if (dispute.status === 'lost') {
      if (await stripeEventAlreadyProcessed(event.id)) return false;
      await cancelReversedStripeSubscriptions(customerId, charge.created);
      override = 'refunded';
    } else if (
      dispute.status === 'won' ||
      dispute.status === 'warning_closed' ||
      dispute.status === 'prevented'
    ) {
      // Closed in the merchant's favour (won, inquiry closed, or prevented):
      // restore what Stripe says now; never resurrect a cancelled subscription.
      const current = await currentStripeSubscriptionState(customerId);
      override = current?.status ?? null;
      subscriptionId = current?.id ?? null;
    } else {
      override = 'past_due';
    }
    return recordStripeFinancialProjection(event, payloadHash, {
      providerObjectId: dispute.id,
      customerId,
      subscriptionId,
      kind: 'dispute',
      status: dispute.status,
      amountMinor: dispute.amount,
      currency: dispute.currency,
      fullReversal: dispute.amount >= charge.amount,
      subscriptionStatusOverride: override,
      chargeOccurredAt: charge.created,
    });
  }
  return null;
}

function mapStripeStatus(
  status: Stripe.Subscription.Status,
): 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'expired' {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'paused':
      return 'paused';
    case 'canceled':
      return 'canceled';
    default:
      return 'expired';
  }
}

interface InvoiceLedgerEntry {
  invoiceId: string;
  kind: FinancialEventKind;
  status: string;
  amountMinor: number;
  currency: string;
}

async function flagDuplicateSubscription(
  eventId: string,
  accountId: string,
  subscriptionId: string,
): Promise<void> {
  const rows = await getSql().query(
    `UPDATE provider_event
    SET error_code = 'duplicate_subscription'
    WHERE provider = 'stripe' AND provider_event_id = $1 AND error_code IS NULL
      AND EXISTS (
        SELECT 1 FROM billing_subscription other
        WHERE other.account_id = $2
          AND other.apple_environment = 'Production'
          AND other.status IN ${LIVE_SUBSCRIPTION_STATUSES}
          AND other.current_period_ends_at > now()
          AND NOT (other.provider = 'stripe' AND other.provider_subscription_id = $3)
      )
    RETURNING 1`,
    [eventId, accountId, subscriptionId],
  );
  if (rows.length > 0) {
    writeLog('warn', 'billing.duplicate_subscription', {
      provider: 'stripe',
      code: 'duplicate_subscription',
    });
  }
}

/** Re-read subscription state so out-of-order deliveries apply the current truth. */
async function authoritativeSubscription(
  snapshot: Stripe.Subscription,
): Promise<Stripe.Subscription> {
  try {
    return await getStripe().subscriptions.retrieve(snapshot.id);
  } catch (error) {
    if (isMissingStripeResource(error)) return snapshot;
    throw error;
  }
}

async function applyStripeSubscription(
  event: Stripe.Event,
  subscription: Stripe.Subscription,
  payloadHash: string,
  ledger?: InvoiceLedgerEntry,
): Promise<boolean> {
  const accountId = z.uuid().safeParse(subscription.metadata.pressay_account_id);
  const item = subscription.items.data.length === 1 ? subscription.items.data[0] : null;
  const interval = item?.price.recurring?.interval;
  const customerId = stripeObjectId(subscription.customer);
  const productId = item ? stripeObjectId(item.price.product) : null;
  const priceId = item?.price.id;
  if (
    !accountId.success ||
    item?.quantity !== 1 ||
    !customerId ||
    !productId ||
    !priceId ||
    (interval !== 'month' && interval !== 'year')
  ) {
    await recordIgnoredStripeEvent(event, payloadHash, null);
    return false;
  }
  const trustContext = z
    .object({ product_matches: z.boolean(), customer_matches: z.boolean() })
    .parse(
      (
        await getSql().query(
          `SELECT
            EXISTS (
              SELECT 1
              FROM billing_product
              WHERE provider = 'stripe'
                AND provider_product_id = $1
                AND provider_price_id = $2
                AND billing_interval = $3
                AND active = true
            ) AS product_matches,
            EXISTS (
              SELECT 1
              FROM billing_customer
              WHERE account_id = $4
                AND stripe_customer_id = $5
            ) AS customer_matches`,
          [productId, priceId, interval, accountId.data, customerId],
        )
      )[0],
    );
  if (!trustContext.product_matches || !trustContext.customer_matches) {
    await recordIgnoredStripeEvent(
      event,
      payloadHash,
      trustContext.product_matches
        ? 'billing_customer_mismatch'
        : 'unconfigured_billing_product',
    );
    return false;
  }

  const status = mapStripeStatus(subscription.status);
  const periodStart = item.current_period_start;
  const periodEnd = item.current_period_end;
  // Ordering: a strictly newer event always wins. Events in the same second
  // (checkout emits created/updated/paid together) may not regress a live
  // subscription to the incomplete ("expired") state.
  const projection = await getSql().query(
    `WITH incoming AS (
      INSERT INTO provider_event (
        provider, provider_event_id, payload_sha256, event_type, provider_occurred_at
      ) VALUES ('stripe', $1, decode($2, 'hex'), $3, to_timestamp($4))
      ${RETRYABLE_PROVIDER_EVENT_CONFLICT}
      RETURNING provider_event_id
    ), subscription_upsert AS (
      INSERT INTO billing_subscription (
        account_id, provider, provider_subscription_id, provider_product_id,
        status, billing_interval, trial_ends_at, current_period_starts_at,
        current_period_ends_at, cancel_at_period_end, provider_event_occurred_at,
        grace_ends_at
      )
      SELECT
        $5, 'stripe', $7, $8, $9, $10,
        CASE WHEN $11::bigint IS NULL THEN NULL ELSE to_timestamp($11) END,
        to_timestamp($12), to_timestamp($13), $14, to_timestamp($4),
        CASE
          WHEN $9::text = 'past_due' THEN to_timestamp($12) + make_interval(secs => $15)
          ELSE NULL
        END
      FROM incoming WHERE $6::text IS NOT NULL
      ON CONFLICT (provider, provider_subscription_id) DO UPDATE SET
        provider_product_id = EXCLUDED.provider_product_id,
        status = EXCLUDED.status,
        billing_interval = EXCLUDED.billing_interval,
        trial_ends_at = EXCLUDED.trial_ends_at,
        current_period_starts_at = EXCLUDED.current_period_starts_at,
        current_period_ends_at = EXCLUDED.current_period_ends_at,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        provider_event_occurred_at = EXCLUDED.provider_event_occurred_at,
        grace_ends_at = EXCLUDED.grace_ends_at,
        updated_at = now()
      WHERE billing_subscription.provider_event_occurred_at < EXCLUDED.provider_event_occurred_at
        OR (
          billing_subscription.provider_event_occurred_at = EXCLUDED.provider_event_occurred_at
          AND NOT (
            EXCLUDED.status = 'expired'
            AND billing_subscription.status IN ('trialing', 'active', 'past_due')
          )
        )
      RETURNING account_id
    ), financial_insert AS (
      INSERT INTO billing_financial_event (
        provider, provider_event_id, provider_object_id, account_id,
        provider_subscription_id, kind, status, amount_minor, currency,
        full_reversal, provider_occurred_at
      )
      SELECT 'stripe', $1, $16, $5, $7, $17, $18, $19, $20, false, to_timestamp($4)
      FROM incoming WHERE $16::text IS NOT NULL
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING account_id
    )
    SELECT finalize_pressay_billing_event(
      'stripe', $1, ARRAY(SELECT account_id FROM subscription_upsert),
      EXISTS (SELECT 1 FROM subscription_upsert)
        OR EXISTS (SELECT 1 FROM financial_insert),
      NULL
    ) AS state`,
    [
      event.id,
      payloadHash,
      event.type,
      event.created,
      accountId.data,
      customerId,
      subscription.id,
      productId,
      status,
      interval,
      subscription.trial_end,
      periodStart,
      periodEnd,
      subscription.cancel_at_period_end,
      pastDueGraceSeconds(),
      ledger?.invoiceId ?? null,
      ledger?.kind ?? null,
      ledger?.status ?? null,
      ledger?.amountMinor ?? null,
      ledger?.currency ?? null,
    ],
  );
  const applied = projection[0]?.state === 'applied';
  if (applied && ['trialing', 'active', 'past_due'].includes(status)) {
    await flagDuplicateSubscription(event.id, accountId.data, subscription.id);
  }
  return applied;
}

async function projectStripeEvent(
  event: Stripe.Event,
  payloadHash: string,
): Promise<{ duplicateOrIgnored: boolean }> {
  if (
    event.type.startsWith('customer.subscription.') &&
    event.data.object.object === 'subscription'
  ) {
    const applied = await applyStripeSubscription(
      event,
      await authoritativeSubscription(event.data.object),
      payloadHash,
    );
    await captureReferralEvent(event);
    return { duplicateOrIgnored: !applied };
  }
  if (event.data.object.object === 'invoice' && event.type.startsWith('invoice.')) {
    const handledTypes = new Set([
      'invoice.paid',
      'invoice.payment_failed',
      'invoice.payment_action_required',
      'invoice.voided',
    ]);
    if (handledTypes.has(event.type)) {
      const applied = await processStripeInvoiceEvent(
        event,
        event.data.object,
        payloadHash,
      );
      await captureReferralEvent(event);
      return { duplicateOrIgnored: !applied };
    }
  }
  const financialEventApplied = await processStripeFinancialEvent(event, payloadHash);
  if (financialEventApplied !== null) {
    await captureReferralEvent(event);
    return { duplicateOrIgnored: !financialEventApplied };
  }
  await recordIgnoredStripeEvent(event, payloadHash, null);
  return { duplicateOrIgnored: true };
}

export async function processStripeWebhook(
  rawBody: string,
  signature: string,
): Promise<{ duplicateOrIgnored: boolean }> {
  const environment = getEnvironment();
  const webhookSecret = environment.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret)
    throw new ApiError(503, 'stripe_webhook_not_configured', 'Webhook unavailable');
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    throw new ApiError(401, 'invalid_stripe_signature', 'Invalid Stripe signature');
  }
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');
  try {
    return await projectStripeEvent(event, payloadHash);
  } catch (error) {
    await recordFailedProviderEvent({
      provider: 'stripe',
      eventId: event.id,
      payloadHash,
      eventType: event.type,
      occurredAtMs: event.created * 1000,
      errorCode: stableErrorCode(error),
    });
    throw error;
  }
}
