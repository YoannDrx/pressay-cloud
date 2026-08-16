import { createHash } from 'node:crypto';

import type Stripe from 'stripe';
import { z } from 'zod';

import { getStripe } from '../billing/stripe-client.ts';
import type { BillingInterval } from '../contracts/billing.ts';
import { getSql } from '../db/client.ts';
import { getEnvironment } from '../env.ts';
import { ApiError } from '../lib/errors.ts';

const checkoutContextSchema = z.object({
  account_id: z.uuid(),
  stripe_customer_id: z.string().nullable(),
  provider_price_id: z.string(),
  trial_ends_at: z.coerce.date().nullable(),
});

async function getCheckoutContext(authUserId: string, interval: BillingInterval) {
  const rows = await getSql().query(
    `SELECT
      a.id AS account_id,
      customer.stripe_customer_id,
      product.provider_price_id,
      CASE WHEN e.source = 'trial' AND e.valid_until > now() THEN e.valid_until END AS trial_ends_at
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
): Promise<string> {
  const environment = getEnvironment();
  const context = await getCheckoutContext(authUserId, interval);
  const customerId = await ensureStripeCustomer(
    authUserId,
    email,
    context.account_id,
    context.stripe_customer_id,
  );
  const now = Math.floor(Date.now() / 1000);
  const trialEnd = context.trial_ends_at
    ? Math.floor(context.trial_ends_at.getTime() / 1000)
    : undefined;
  const session = await getStripe().checkout.sessions.create(
    {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: context.provider_price_id, quantity: 1 }],
      success_url: environment.STRIPE_CHECKOUT_SUCCESS_URL,
      cancel_url: environment.STRIPE_CHECKOUT_CANCEL_URL,
      allow_promotion_codes: true,
      client_reference_id: context.account_id,
      metadata: { pressay_account_id: context.account_id },
      subscription_data: {
        metadata: { pressay_account_id: context.account_id },
        ...(trialEnd && trialEnd >= now + 48 * 60 * 60 ? { trial_end: trialEnd } : {}),
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
): Promise<void> {
  const accountId = z.uuid().safeParse(subscription.metadata.pressay_account_id);
  const item = subscription.items.data[0];
  const interval = item?.price.recurring?.interval;
  const customerId = stripeObjectId(subscription.customer);
  const productId = item ? stripeObjectId(item.price.product) : null;
  if (
    !accountId.success ||
    !item ||
    !customerId ||
    !productId ||
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
    return;
  }

  const status = mapStripeStatus(subscription.status);
  const active = ['trialing', 'active', 'past_due'].includes(status);
  const periodStart = item.current_period_start;
  const periodEnd = item.current_period_end;
  await getSql().query(
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
    ), entitlement_update AS (
      UPDATE entitlement e
      SET
        tier = CASE WHEN $15 THEN 'pro' ELSE 'free' END,
        source = CASE WHEN $15 THEN 'stripe' ELSE 'none' END,
        valid_from = CASE WHEN $15 THEN to_timestamp($12) ELSE now() END,
        valid_until = CASE WHEN $15 THEN to_timestamp($13) ELSE NULL END,
        offline_grace_until = CASE WHEN $15 THEN to_timestamp($13) + interval '72 hours' ELSE NULL END,
        revision = e.revision + 1,
        updated_at = now()
      FROM subscription_upsert s
      WHERE e.account_id = s.account_id
        AND (e.source IN ('none', 'trial', 'stripe') OR $15)
      RETURNING e.account_id
    )
    UPDATE provider_event pe
    SET
      state = CASE WHEN EXISTS (SELECT 1 FROM subscription_upsert) THEN 'applied' ELSE 'ignored' END,
      processed_at = now()
    WHERE pe.provider = 'stripe'
      AND pe.provider_event_id = $1
      AND pe.state = 'received'`,
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
      active,
    ],
  );
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
    await applyStripeSubscription(event, event.data.object, payloadHash);
    return { duplicateOrIgnored: false };
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
