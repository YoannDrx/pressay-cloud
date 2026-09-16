import { referralSummarySchema } from '../contracts/operations.js';
import type { ReferralSummary } from '../contracts/operations-wire.js';
import { randomBytes } from 'node:crypto';
import type Stripe from 'stripe';
import { getSql } from '../db/client.js';
import { getStripe } from '../billing/stripe-client.js';
import { getEnvironment } from '../env.js';
import { ApiError } from '../lib/errors.js';

export function requireReferrals() {
  if (!getEnvironment().PRESSAY_REFERRALS_ENABLED)
    throw new ApiError(503, 'referrals_disabled', 'Referral program is not open yet');
}
export async function myReferrals(id: string): Promise<ReferralSummary> {
  requireReferrals();
  await getSql().query(
    'INSERT INTO referral_code(account_id,code) VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING',
    [id, randomBytes(8).toString('hex').toUpperCase()],
  );
  const [code, stats, rewards] = await Promise.all([
    getSql().query('SELECT code FROM referral_code WHERE account_id=$1', [id]),
    getSql().query(
      "SELECT count(*)::int AS signups,count(*) FILTER(WHERE status='converted')::int AS conversions FROM referral_attribution WHERE referrer_id=$1",
      [id],
    ),
    getSql().query(
      'SELECT id,side,status,kind,amount_minor,currency,applied_at,last_error_code FROM referral_reward WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100',
      [id],
    ),
  ]);
  return referralSummarySchema.parse({
    link: `https://press-say.app/r/${String(code[0]?.code)}`,
    ...stats[0],
    rewards,
  });
}
export async function attributeReferral(id: string, code: string, issuedAt: number) {
  requireReferrals();
  const now = Math.floor(Date.now() / 1000);
  if (issuedAt > now + 60 || issuedAt < now - 30 * 86400)
    throw new ApiError(422, 'referral_expired', 'Referral link expired');
  const rows = await getSql().query(
    'SELECT attribute_pressay_referral($1,$2,to_timestamp($3)) AS attributed',
    [id, code, issuedAt],
  );
  return { attributed: rows[0]?.attributed === true };
}
function objectId(value: string | { id: string } | null | undefined) {
  return typeof value === 'string' ? value : value?.id;
}
/** Called on every verified delivery, even when entitlement projection is a duplicate. */
export async function captureReferralEvent(event: Stripe.Event) {
  const env = getEnvironment();
  if (
    !env.PRESSAY_REFERRALS_ENABLED ||
    event.livemode !== (env.PRESSAY_DEPLOYMENT_ENV === 'production')
  )
    return;
  const stripe = getStripe();
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    const subscriptionId = objectId(invoice.parent?.subscription_details?.subscription);
    if (!subscriptionId || invoice.amount_paid <= 0 || invoice.currency !== 'eur')
      return;
    const rows = await getSql().query(
      `SELECT a.id FROM pressay_account a
      JOIN billing_subscription s ON s.account_id=a.id AND s.provider='stripe' AND s.provider_subscription_id=$1
      JOIN billing_customer c ON c.account_id=a.id AND c.stripe_customer_id=$2
      WHERE a.status='active'`,
      [subscriptionId, objectId(invoice.customer)],
    );
    if (!rows[0]) return;
    // Resolve the first actual Pressay payment from Stripe, independently of delivery order.
    const eligible = await getSql().query(
      "SELECT 1 FROM referral_attribution WHERE referee_id=$1 AND status='attributed'",
      [rows[0].id],
    );
    if (!eligible.length) return;
    const subscriptions = await getSql().query(
      "SELECT provider_subscription_id FROM billing_subscription WHERE account_id=$1 AND provider='stripe'",
      [rows[0].id],
    );
    const ids = new Set(subscriptions.map((s) => String(s.provider_subscription_id)));
    const invoices: Stripe.Invoice[] = [];
    for await (const candidate of stripe.invoices.list({
      customer: String(objectId(invoice.customer)),
      status: 'paid',
      limit: 100,
    })) {
      if (invoices.length >= 100)
        throw new ApiError(
          503,
          'referral_history_review',
          'Payment history needs reconciliation',
        );
      invoices.push(candidate);
    }
    invoices.sort(
      (a, b) =>
        (a.status_transitions.paid_at ?? a.created) -
        (b.status_transitions.paid_at ?? b.created),
    );
    for (const candidate of invoices) {
      if (
        candidate.livemode !== event.livemode ||
        candidate.amount_paid <= 0 ||
        candidate.currency !== 'eur' ||
        !ids.has(objectId(candidate.parent?.subscription_details?.subscription) ?? '')
      )
        continue;
      const payments = await stripe.invoicePayments.list({
        invoice: candidate.id,
        status: 'paid',
        limit: 100,
      });
      // Balance credit and out-of-band mark-paid do not count as money collected.
      const paid = payments.data
        .filter(
          (p) => p.livemode === event.livemode && p.payment.type === 'payment_intent',
        )
        .reduce((n, p) => n + (p.amount_paid ?? 0), 0);
      if (paid <= 0) continue;
      await getSql().query(
        'SELECT record_pressay_referral_payment($1,$2,to_timestamp($3),$4,$5,$6,$7)',
        [
          candidate.id,
          rows[0].id,
          candidate.status_transitions.paid_at ?? candidate.created,
          paid,
          candidate.currency,
          env.PRESSAY_PRO_MONTHLY_AMOUNT_MINOR,
          env.PRESSAY_PRO_ANNUAL_AMOUNT_MINOR,
        ],
      );
      break;
    }
  }
  let charge: Stripe.Charge | null = null;
  if (event.type === 'charge.refunded') charge = event.data.object;
  if (
    event.type.startsWith('refund.') &&
    event.data.object.object === 'refund' &&
    event.data.object.status === 'succeeded'
  ) {
    const id = objectId(event.data.object.charge);
    if (id) charge = await stripe.charges.retrieve(id);
  }
  if (
    event.type.startsWith('charge.dispute.') &&
    event.data.object.object === 'dispute' &&
    !['won', 'warning_closed'].includes(event.data.object.status)
  ) {
    const id = objectId(event.data.object.charge);
    if (id) charge = await stripe.charges.retrieve(id);
  }
  const intent = objectId(charge?.payment_intent);
  if (intent) {
    for await (const payment of stripe.invoicePayments.list({
      payment: { type: 'payment_intent', payment_intent: intent },
      limit: 100,
    })) {
      await getSql().query('SELECT reverse_pressay_referral($1)', [
        objectId(payment.invoice),
      ]);
    }
  }
}
export function referralCredit(interval: string, monthly: number, annual: number) {
  return interval === 'year' ? Math.round((annual * 30) / 365) : monthly;
}
export async function runReferralRewards(limit = 10) {
  if (!getEnvironment().PRESSAY_REFERRALS_ENABLED) return { processed: 0 };
  let processed = 0;
  const deadline = Date.now() + 35000;
  for (let i = 0; i < Math.min(25, limit); i++) {
    if (Date.now() > deadline) break;
    const rows = await getSql().query(
      `WITH candidate AS (
      SELECT r.id FROM referral_reward r JOIN referral_attribution a ON a.id=r.attribution_id
      JOIN pressay_account account ON account.id=r.account_id AND account.status='active'
      WHERE a.status='converted' AND r.status IN ('pending','failed','processing') AND r.attempts<8
        AND r.next_attempt_at<=now() AND (r.locked_until IS NULL OR r.locked_until<now())
      ORDER BY r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1)
      UPDATE referral_reward r SET status='processing',attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,now()),locked_until=now()+interval '10 minutes'
      FROM candidate WHERE r.id=candidate.id RETURNING r.*`,
      [],
    );
    if (!rows[0]) break;
    const r = rows[0];
    try {
      if (!r.kind) {
        const subscriptions = await getSql().query(
          `SELECT s.provider,s.billing_interval,c.stripe_customer_id FROM billing_subscription s
          LEFT JOIN billing_customer c ON c.account_id=s.account_id
          WHERE s.account_id=$1 AND s.apple_environment='Production' AND s.status IN ('active','trialing','past_due','grace') AND s.current_period_ends_at>now()
          ORDER BY (s.provider='app_store') DESC LIMIT 1`,
          [r.account_id],
        );
        const sub = subscriptions[0];
        r.kind =
          sub?.provider === 'app_store'
            ? 'apple_ineligible'
            : sub?.provider === 'stripe'
              ? 'credit'
              : 'grant';
        r.customer_id = sub?.stripe_customer_id ? String(sub.stripe_customer_id) : null;
        r.currency = 'eur';
        const env = getEnvironment();
        r.amount_minor =
          r.kind === 'credit'
            ? referralCredit(
                String(sub?.billing_interval),
                env.PRESSAY_PRO_MONTHLY_AMOUNT_MINOR,
                env.PRESSAY_PRO_ANNUAL_AMOUNT_MINOR,
              )
            : null;
        await getSql().query(
          "UPDATE referral_reward SET kind=$2,customer_id=$3,amount_minor=$4,currency=$5 WHERE id=$1 AND status='processing'",
          [r.id, r.kind, r.customer_id, r.amount_minor, r.currency],
        );
      }
      if (r.kind === 'grant')
        await getSql().query('SELECT apply_pressay_referral_grant($1)', [r.id]);
      else if (r.kind === 'apple_ineligible')
        await getSql().query(
          "UPDATE referral_reward SET status='cancelled',last_error_code='apple_ineligible',locked_until=NULL WHERE id=$1 AND status='processing'",
          [r.id],
        );
      else {
        // Do not reissue an uncertain Stripe write after its idempotency retention window.
        if (
          Number(r.attempts) > 1 &&
          Date.now() - new Date(String(r.first_attempt_at ?? r.created_at)).getTime() >
            23 * 3600000
        ) {
          await getSql().query(
            "UPDATE referral_reward SET status='review',last_error_code='credit_reconciliation_required',locked_until=NULL WHERE id=$1",
            [r.id],
          );
          continue;
        }
        const state = await getSql().query(
          "SELECT 1 FROM referral_reward WHERE id=$1 AND status='processing'",
          [r.id],
        );
        if (!state.length) continue;
        const credit = await getStripe().customers.createBalanceTransaction(
          String(r.customer_id),
          {
            amount: -Number(r.amount_minor),
            currency: 'eur',
            description: 'Pressay referral reward',
            metadata: { pressay_reward_id: String(r.id) },
          },
          {
            idempotencyKey: `referral/reward/${r.id}`,
            timeout: 8000,
            maxNetworkRetries: 0,
          },
        );
        await getSql().query(
          "UPDATE referral_reward SET stripe_transaction_id=$2,status=CASE WHEN status='processing' THEN 'applied' ELSE 'review' END,applied_at=now(),locked_until=NULL WHERE id=$1",
          [r.id, credit.id],
        );
      }
      processed++;
    } catch {
      await getSql().query(
        "UPDATE referral_reward SET status='failed',last_error_code='reward_processing_failed',locked_until=NULL,next_attempt_at=now()+interval '15 minutes' WHERE id=$1 AND status='processing'",
        [r.id],
      );
    }
  }
  return { processed };
}
