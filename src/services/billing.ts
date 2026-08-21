import { createHash, randomBytes } from 'node:crypto';

import type Stripe from 'stripe';
import { z } from 'zod';

import { getStripe } from '../billing/stripe-client.js';
import type { BillingInterval } from '../contracts/billing.js';
import { getSql } from '../db/client.js';
import { getEnvironment } from '../env.js';
import { ApiError } from '../lib/errors.js';

const checkoutContextSchema = z.object({
  account_id: z.uuid(),
  stripe_customer_id: z.string().nullable(),
  provider_price_id: z.string(),
});

function checkoutIntegrationIdentifier(): string {
  const suffix = Array.from(randomBytes(8), (byte) =>
    String.fromCharCode(97 + (byte % 26)),
  ).join('');
  return `pressay_checkout_${suffix}`;
}

async function getCheckoutContext(authUserId: string, interval: BillingInterval) {
  const rows = await getSql().query(
    `SELECT
      a.id AS account_id,
      customer.stripe_customer_id,
      product.provider_price_id
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
  if (existingCustomerId) return existingCustomerId;
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
  const session = await getStripe().checkout.sessions.create(
    {
      mode: 'subscription',
      integration_identifier: checkoutIntegrationIdentifier(),
      customer: customerId,
      line_items: [{ price: context.provider_price_id, quantity: 1 }],
      success_url: environment.STRIPE_CHECKOUT_SUCCESS_URL,
      cancel_url: environment.STRIPE_CHECKOUT_CANCEL_URL,
      allow_promotion_codes: true,
      client_reference_id: context.account_id,
      metadata: { pressay_account_id: context.account_id },
      subscription_data: {
        metadata: { pressay_account_id: context.account_id },
      },
    },
    { idempotencyKey },
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

function stripeObjectId(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

type FinancialEventKind =
  'invoice_paid' | 'invoice_failed' | 'invoice_voided' | 'refund' | 'dispute';

interface FinancialProjection {
  providerObjectId: string;
  customerId: string;
  subscriptionId: string | null;
  kind: FinancialEventKind;
  status: string;
  amountMinor: number;
  currency: string;
  fullReversal: boolean;
  subscriptionStatusOverride: 'active' | 'past_due' | 'refunded' | null;
  chargeOccurredAt: number | null;
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
      ON CONFLICT (provider, provider_event_id) DO NOTHING
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
      SET status = $13, updated_at = now(), provider_event_occurred_at = to_timestamp($4)
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
    ), entitlement_refresh AS (
      SELECT recompute_pressay_entitlement(account_id) AS changed
      FROM subscription_update
    )
    UPDATE provider_event event
    SET
      state = CASE WHEN EXISTS (SELECT 1 FROM financial_insert) THEN 'applied' ELSE 'ignored' END,
      error_code = CASE WHEN EXISTS (SELECT 1 FROM financial_insert) THEN NULL ELSE 'billing_customer_not_found' END,
      processed_at = now()
    WHERE event.provider = 'stripe'
      AND event.provider_event_id = $1
      AND event.state = 'received'
    RETURNING state`,
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
  const applied = await applyStripeSubscription(event, subscription, payloadHash);
  if (!applied) return false;
  const customerId = stripeObjectId(invoice.customer);
  if (!customerId) return false;
  const kind: FinancialEventKind =
    event.type === 'invoice.paid'
      ? 'invoice_paid'
      : event.type === 'invoice.voided'
        ? 'invoice_voided'
        : 'invoice_failed';
  await getSql().query(
    `INSERT INTO billing_financial_event (
      provider, provider_event_id, provider_object_id, account_id,
      provider_subscription_id, kind, status, amount_minor, currency,
      full_reversal, provider_occurred_at
    )
    SELECT
      'stripe', $1, $2, customer.account_id, $3, $4, $5, $6, $7,
      false, to_timestamp($8)
    FROM billing_customer customer
    WHERE customer.stripe_customer_id = $9
    ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    [
      event.id,
      invoice.id,
      subscription.id,
      kind,
      invoice.status ?? event.type,
      event.type === 'invoice.paid' ? invoice.amount_paid : invoice.amount_due,
      invoice.currency,
      event.created,
      customerId,
    ],
  );
  return true;
}

async function resolveCharge(
  charge: string | Stripe.Charge | null,
): Promise<Stripe.Charge | null> {
  if (!charge) return null;
  return typeof charge === 'string' ? getStripe().charges.retrieve(charge) : charge;
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
    const override =
      dispute.status === 'lost'
        ? 'refunded'
        : dispute.status === 'won'
          ? 'active'
          : 'past_due';
    return recordStripeFinancialProjection(event, payloadHash, {
      providerObjectId: dispute.id,
      customerId,
      subscriptionId: null,
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

async function applyStripeSubscription(
  event: Stripe.Event,
  subscription: Stripe.Subscription,
  payloadHash: string,
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
    await getSql().query(
      `INSERT INTO provider_event (
        provider, provider_event_id, payload_sha256, event_type,
        provider_occurred_at, state, processed_at
      ) VALUES ('stripe', $1, decode($2, 'hex'), $3, to_timestamp($4), 'ignored', now())
      ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [event.id, payloadHash, event.type, event.created],
    );
    return false;
  }
  const configuredProduct = await getSql().query(
    `SELECT id
    FROM billing_product
    WHERE provider = 'stripe'
      AND provider_product_id = $1
      AND provider_price_id = $2
      AND billing_interval = $3
      AND active = true`,
    [productId, priceId, interval],
  );
  if (configuredProduct.length !== 1) {
    await getSql().query(
      `INSERT INTO provider_event (
        provider, provider_event_id, payload_sha256, event_type,
        provider_occurred_at, state, error_code, processed_at
      ) VALUES (
        'stripe', $1, decode($2, 'hex'), $3, to_timestamp($4),
        'ignored', 'unconfigured_billing_product', now()
      )
      ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [event.id, payloadHash, event.type, event.created],
    );
    return false;
  }

  const status = mapStripeStatus(subscription.status);
  const periodStart = item.current_period_start;
  const periodEnd = item.current_period_end;
  const projection = await getSql().query(
    `WITH incoming AS (
      INSERT INTO provider_event (
        provider, provider_event_id, payload_sha256, event_type, provider_occurred_at
      ) VALUES ('stripe', $1, decode($2, 'hex'), $3, to_timestamp($4))
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING provider_event_id
    ), customer_upsert AS (
      INSERT INTO billing_customer (account_id, stripe_customer_id)
      SELECT $5, $6 FROM incoming
      ON CONFLICT (account_id) DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        updated_at = now()
      RETURNING account_id
    ), subscription_upsert AS (
      INSERT INTO billing_subscription (
        account_id, provider, provider_subscription_id, provider_product_id,
        status, billing_interval, trial_ends_at, current_period_starts_at,
        current_period_ends_at, cancel_at_period_end, provider_event_occurred_at
      )
      SELECT
        $5, 'stripe', $7, $8, $9, $10,
        CASE WHEN $11::bigint IS NULL THEN NULL ELSE to_timestamp($11) END,
        to_timestamp($12), to_timestamp($13), $14, to_timestamp($4)
      FROM incoming
      ON CONFLICT (provider, provider_subscription_id) DO UPDATE SET
        provider_product_id = EXCLUDED.provider_product_id,
        status = EXCLUDED.status,
        billing_interval = EXCLUDED.billing_interval,
        trial_ends_at = EXCLUDED.trial_ends_at,
        current_period_starts_at = EXCLUDED.current_period_starts_at,
        current_period_ends_at = EXCLUDED.current_period_ends_at,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        provider_event_occurred_at = EXCLUDED.provider_event_occurred_at,
        updated_at = now()
      WHERE billing_subscription.provider_event_occurred_at <= EXCLUDED.provider_event_occurred_at
      RETURNING account_id
    ), entitlement_refresh AS (
      SELECT recompute_pressay_entitlement(account_id) AS changed
      FROM subscription_upsert
    )
    UPDATE provider_event pe
    SET
      state = CASE WHEN EXISTS (SELECT 1 FROM entitlement_refresh) THEN 'applied' ELSE 'ignored' END,
      processed_at = now()
    WHERE pe.provider = 'stripe'
      AND pe.provider_event_id = $1
      AND pe.state = 'received'
    RETURNING state`,
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
    ],
  );
  return projection[0]?.state === 'applied';
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
  if (
    event.type.startsWith('customer.subscription.') &&
    event.data.object.object === 'subscription'
  ) {
    const applied = await applyStripeSubscription(
      event,
      event.data.object,
      payloadHash,
    );
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
      return { duplicateOrIgnored: !applied };
    }
  }
  const financialEventApplied = await processStripeFinancialEvent(event, payloadHash);
  if (financialEventApplied !== null) {
    return { duplicateOrIgnored: !financialEventApplied };
  }
  await getSql().query(
    `INSERT INTO provider_event (
      provider, provider_event_id, payload_sha256, event_type,
      provider_occurred_at, state, processed_at
    ) VALUES ('stripe', $1, decode($2, 'hex'), $3, to_timestamp($4), 'ignored', now())
    ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    [event.id, payloadHash, event.type, event.created],
  );
  return { duplicateOrIgnored: true };
}
