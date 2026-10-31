import Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const retrieveSubscription = vi.hoisted(() => vi.fn());
const cancelSubscription = vi.hoisted(() => vi.fn());
const retrieveCharge = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));
vi.mock('../src/billing/stripe-client.ts', async () => {
  const { default: StripeClient } = await import('stripe');
  const real = new StripeClient('sk_test_placeholder', {
    apiVersion: '2026-08-26.dahlia',
  });
  return {
    getStripe: () => ({
      webhooks: real.webhooks,
      subscriptions: { retrieve: retrieveSubscription, cancel: cancelSubscription },
      charges: { retrieve: retrieveCharge },
    }),
    clearStripeForTests: () => undefined,
  };
});

import { clearStripeForTests } from '../src/billing/stripe-client.ts';
import { checkoutRequestSchema } from '../src/contracts/billing.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { processStripeWebhook } from '../src/services/billing.ts';

const signingSecret = 'whsec_test_signing_secret';
const stripe = new Stripe('sk_test_placeholder', {
  apiVersion: '2026-08-26.dahlia',
});
const payload = JSON.stringify({
  id: 'evt_pressay_subscription_1',
  object: 'event',
  livemode: false,
  api_version: '2026-07-29.dahlia',
  created: 1_786_924_800,
  type: 'customer.subscription.updated',
  data: {
    object: {
      id: 'sub_pressay_1',
      object: 'subscription',
      customer: 'cus_pressay_1',
      metadata: {
        pressay_account_id: '00000000-0000-4000-8000-000000000001',
      },
      status: 'active',
      trial_end: null,
      cancel_at_period_end: false,
      items: {
        object: 'list',
        data: [
          {
            id: 'si_pressay_1',
            object: 'subscription_item',
            quantity: 1,
            current_period_start: 1_786_924_800,
            current_period_end: 1_789_603_200,
            price: {
              id: 'price_server_owned',
              object: 'price',
              product: 'prod_pressay_pro',
              recurring: { interval: 'month' },
            },
          },
        ],
      },
    },
  },
});

function callArgument(index: number, position: number): unknown {
  const call = query.mock.calls[index] as [string, unknown[]] | undefined;
  return call?.[1][position];
}

function subscriptionSnapshot(): Record<string, unknown> {
  return (JSON.parse(payload) as { data: { object: Record<string, unknown> } }).data
    .object;
}

function sign(body: string): string {
  return stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: signingSecret,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

describe('Stripe webhook processing', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([]);
    retrieveSubscription.mockReset();
    cancelSubscription.mockReset();
    retrieveCharge.mockReset();
    // By default Stripe confirms the state carried by the event snapshot.
    retrieveSubscription.mockImplementation((id: string) =>
      Promise.resolve({ ...subscriptionSnapshot(), id }),
    );
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
    process.env.STRIPE_WEBHOOK_SECRET = signingSecret;
    clearEnvironmentCacheForTests();
    clearStripeForTests();
  });

  it('verifies the untouched body before applying subscription metadata', async () => {
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: true }])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await expect(processStripeWebhook(payload, signature)).resolves.toEqual({
      duplicateOrIgnored: false,
    });
    expect(retrieveSubscription).toHaveBeenCalledWith('sub_pressay_1');
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[0]).toContain("error_code = 'duplicate_subscription'");
    const serializedCall = JSON.stringify(query.mock.calls);
    expect(serializedCall).toContain('evt_pressay_subscription_1');
    expect(serializedCall).not.toContain(payload);
  });

  it('ignores a signed subscription event for a Price outside the active catalogue', async () => {
    query
      .mockResolvedValueOnce([{ product_matches: false, customer_matches: true }])
      .mockResolvedValueOnce([]);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await expect(processStripeWebhook(payload, signature)).resolves.toEqual({
      duplicateOrIgnored: true,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("'ignored', $5"),
      expect.arrayContaining([
        'evt_pressay_subscription_1',
        'unconfigured_billing_product',
      ]),
    );
  });

  it('ignores a configured subscription when its Stripe customer belongs elsewhere', async () => {
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: false }])
      .mockResolvedValueOnce([]);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await expect(processStripeWebhook(payload, signature)).resolves.toEqual({
      duplicateOrIgnored: true,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("'ignored', $5"),
      expect.arrayContaining(['billing_customer_mismatch']),
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('ignores subscriptions containing more than one item', async () => {
    const parsed = JSON.parse(payload) as {
      data: { object: { items: { data: unknown[] } } };
    };
    parsed.data.object.items.data.push(parsed.data.object.items.data[0]);
    retrieveSubscription.mockResolvedValueOnce(parsed.data.object);
    const multiItemPayload = JSON.stringify(parsed);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: multiItemPayload,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await expect(processStripeWebhook(multiItemPayload, signature)).resolves.toEqual({
      duplicateOrIgnored: true,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("'ignored'");
  });

  it('records a paid invoice after revalidating its subscription catalogue', async () => {
    const subscription = (
      JSON.parse(payload) as { data: { object: Record<string, unknown> } }
    ).data.object;
    const invoicePayload = JSON.stringify({
      id: 'evt_pressay_invoice_paid_1',
      object: 'event',
      livemode: false,
      api_version: '2026-07-29.dahlia',
      created: 1_786_924_900,
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_pressay_1',
          object: 'invoice',
          customer: 'cus_pressay_1',
          status: 'paid',
          amount_paid: 799,
          amount_due: 799,
          currency: 'eur',
          parent: {
            type: 'subscription_details',
            quote_details: null,
            subscription_details: { subscription, metadata: null },
          },
        },
      },
    });
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: true }])
      .mockResolvedValueOnce([{ state: 'applied' }])
      .mockResolvedValueOnce([]);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: invoicePayload,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await expect(processStripeWebhook(invoicePayload, signature)).resolves.toEqual({
      duplicateOrIgnored: false,
    });
    // The ledger row is part of the projection statement, not a second write.
    expect(query.mock.calls[1]?.[0]).toContain('subscription_upsert');
    expect(query.mock.calls[1]?.[0]).toContain('INSERT INTO billing_financial_event');
    expect(query.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['in_pressay_1', 'invoice_paid', 'paid', 799, 'eur']),
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain(invoicePayload);
  });

  it('records a full refund and projects a refunded entitlement state', async () => {
    const refundPayload = JSON.stringify({
      id: 'evt_pressay_refund_1',
      object: 'event',
      livemode: false,
      api_version: '2026-07-29.dahlia',
      created: 1_786_924_950,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_pressay_1',
          object: 'charge',
          customer: 'cus_pressay_1',
          amount: 799,
          amount_refunded: 799,
          currency: 'eur',
          created: 1_786_924_800,
        },
      },
    });
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ provider_subscription_id: 'sub_pressay_1' }])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    cancelSubscription.mockResolvedValueOnce({
      id: 'sub_pressay_1',
      status: 'canceled',
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: refundPayload,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await expect(processStripeWebhook(refundPayload, signature)).resolves.toEqual({
      duplicateOrIgnored: false,
    });
    // A full refund stops future renewals before the ledger is written.
    expect(cancelSubscription).toHaveBeenCalledWith(
      'sub_pressay_1',
      {},
      { idempotencyKey: 'pressay-reversal-cancel/sub_pressay_1' },
    );
    expect(query.mock.calls[1]?.[1]).toEqual(['cus_pressay_1', 1_786_924_800]);
    expect(query.mock.calls[2]?.[0]).toContain('billing_financial_event');
    expect(query.mock.calls[2]?.[1]).toContain('refunded');
    expect(query.mock.calls[2]?.[1]).toContain(true);
  });

  it('applies the authoritative Stripe state when created and updated share a second', async () => {
    // customer.subscription.created carries the incomplete checkout snapshot
    // but is delivered after the activation in the same second.
    const createdPayload = JSON.stringify({
      ...(JSON.parse(payload) as Record<string, unknown>),
      id: 'evt_pressay_subscription_created',
      type: 'customer.subscription.created',
      data: { object: { ...subscriptionSnapshot(), status: 'incomplete' } },
    });
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: true }])
      .mockResolvedValueOnce([{ state: 'ignored' }]);
    await processStripeWebhook(createdPayload, sign(createdPayload));
    const upsert = query.mock.calls[1];
    expect(callArgument(1, 8)).toBe('active');
    expect(upsert?.[0]).toContain(
      'billing_subscription.provider_event_occurred_at < EXCLUDED.provider_event_occurred_at',
    );
    expect(upsert?.[0]).toContain("EXCLUDED.status = 'expired'");
  });

  it('falls back to the event snapshot only when Stripe no longer has the subscription', async () => {
    retrieveSubscription.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'resource_missing' }),
    );
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: true }])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    await expect(processStripeWebhook(payload, sign(payload))).resolves.toEqual({
      duplicateOrIgnored: false,
    });
  });

  it('caps past_due access with the configured grace window', async () => {
    process.env.STRIPE_PAST_DUE_GRACE_DAYS = '5';
    clearEnvironmentCacheForTests();
    retrieveSubscription.mockResolvedValueOnce({
      ...subscriptionSnapshot(),
      status: 'past_due',
    });
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: true }])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    await processStripeWebhook(payload, sign(payload));
    const upsert = query.mock.calls[1];
    expect(callArgument(1, 8)).toBe('past_due');
    expect(callArgument(1, 14)).toBe(5 * 86_400);
    expect(upsert?.[0]).toContain('make_interval(secs => $15)');
    delete process.env.STRIPE_PAST_DUE_GRACE_DAYS;
  });

  it('restores the live Stripe status after a won dispute instead of forcing active', async () => {
    const disputePayload = JSON.stringify({
      id: 'evt_pressay_dispute_won',
      object: 'event',
      livemode: false,
      api_version: '2026-07-29.dahlia',
      created: 1_786_925_000,
      type: 'charge.dispute.closed',
      data: {
        object: {
          id: 'dp_pressay_1',
          object: 'dispute',
          charge: 'ch_pressay_1',
          amount: 799,
          currency: 'eur',
          status: 'won',
        },
      },
    });
    retrieveCharge.mockResolvedValueOnce({
      id: 'ch_pressay_1',
      customer: 'cus_pressay_1',
      amount: 799,
      created: 1_786_924_800,
    });
    retrieveSubscription.mockResolvedValueOnce({
      ...subscriptionSnapshot(),
      status: 'canceled',
    });
    query
      .mockResolvedValueOnce([{ provider_subscription_id: 'sub_pressay_1' }])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    await processStripeWebhook(disputePayload, sign(disputePayload));
    const projection = query.mock.calls[1];
    expect(projection?.[0]).toContain('billing_financial_event');
    expect(callArgument(1, 12)).toBe('canceled');
    expect(callArgument(1, 6)).toBe('sub_pressay_1');
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it.each(['warning_closed', 'prevented'] as const)(
    'restores the live Stripe status when a dispute closes as %s',
    async (status) => {
      const disputePayload = JSON.stringify({
        id: `evt_pressay_dispute_${status}`,
        object: 'event',
        livemode: false,
        api_version: '2026-07-29.dahlia',
        created: 1_786_925_000,
        type: 'charge.dispute.closed',
        data: {
          object: {
            id: 'dp_pressay_1',
            object: 'dispute',
            charge: 'ch_pressay_1',
            amount: 799,
            currency: 'eur',
            status,
          },
        },
      });
      retrieveCharge.mockResolvedValueOnce({
        id: 'ch_pressay_1',
        customer: 'cus_pressay_1',
        amount: 799,
        created: 1_786_924_800,
      });
      retrieveSubscription.mockResolvedValueOnce(subscriptionSnapshot());
      query
        .mockResolvedValueOnce([{ provider_subscription_id: 'sub_pressay_1' }])
        .mockResolvedValueOnce([{ state: 'applied' }]);
      await processStripeWebhook(disputePayload, sign(disputePayload));
      expect(callArgument(1, 12)).toBe('active');
      expect(cancelSubscription).not.toHaveBeenCalled();
    },
  );

  it('cancels renewals after a lost dispute', async () => {
    const disputePayload = JSON.stringify({
      id: 'evt_pressay_dispute_lost',
      object: 'event',
      livemode: false,
      api_version: '2026-07-29.dahlia',
      created: 1_786_925_000,
      type: 'charge.dispute.closed',
      data: {
        object: {
          id: 'dp_pressay_2',
          object: 'dispute',
          charge: 'ch_pressay_1',
          amount: 799,
          currency: 'eur',
          status: 'lost',
        },
      },
    });
    retrieveCharge.mockResolvedValueOnce({
      id: 'ch_pressay_1',
      customer: 'cus_pressay_1',
      amount: 799,
      created: 1_786_924_800,
    });
    cancelSubscription.mockRejectedValueOnce(new Error('already canceled'));
    retrieveSubscription.mockResolvedValueOnce({
      id: 'sub_pressay_1',
      status: 'canceled',
    });
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ provider_subscription_id: 'sub_pressay_1' }])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    await expect(
      processStripeWebhook(disputePayload, sign(disputePayload)),
    ).resolves.toEqual({ duplicateOrIgnored: false });
    expect(callArgument(2, 12)).toBe('refunded');
  });

  it('records a processing failure with a stable code and lets Stripe retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: true }])
      .mockRejectedValueOnce(
        Object.assign(new Error('could not serialize access for customer x'), {
          code: '40001',
        }),
      )
      .mockResolvedValueOnce([]);
    await expect(processStripeWebhook(payload, sign(payload))).rejects.toThrow();
    const failure = query.mock.calls[2];
    expect(failure?.[0]).toContain("'failed'");
    expect(failure?.[1]).toEqual(
      expect.arrayContaining([
        'stripe',
        'evt_pressay_subscription_1',
        'database_40001',
      ]),
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain('could not serialize');
    expect(error.mock.calls.map((call) => String(call[0])).join('')).toContain(
      '"code":"database_40001"',
    );
    error.mockRestore();
  });

  it('retries a previously failed delivery instead of treating it as a duplicate', async () => {
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: true }])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    await processStripeWebhook(payload, sign(payload));
    expect(query.mock.calls[1]?.[0]).toContain("WHERE provider_event.state = 'failed'");
  });

  it('flags a second live subscription for support without refusing the event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: true }])
      .mockResolvedValueOnce([{ state: 'applied' }])
      .mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(processStripeWebhook(payload, sign(payload))).resolves.toEqual({
      duplicateOrIgnored: false,
    });
    expect(warn.mock.calls.map((call) => String(call[0])).join('')).toContain(
      'billing.duplicate_subscription',
    );
    warn.mockRestore();
  });

  it('ignores a test-mode event in production without touching Postgres', async () => {
    process.env.PRESSAY_DEPLOYMENT_ENV = 'production';
    process.env.ENTITLEMENT_SIGNING_KEY_ID = 'pressay-entitlement-production-2026-01';
    process.env.STRIPE_SECRET_KEY = 'rk_live_placeholder';
    clearEnvironmentCacheForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(processStripeWebhook(payload, sign(payload))).resolves.toEqual({
        duplicateOrIgnored: true,
        code: 'stripe_livemode_mismatch',
      });
      expect(query).not.toHaveBeenCalled();
      expect(retrieveSubscription).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        'billing.webhook.livemode_mismatch',
      );
    } finally {
      warn.mockRestore();
      delete process.env.PRESSAY_DEPLOYMENT_ENV;
      delete process.env.ENTITLEMENT_SIGNING_KEY_ID;
      clearEnvironmentCacheForTests();
    }
  });

  it.each([
    ['a live-mode event', { livemode: true }],
    ['an event without a mode', { livemode: undefined }],
  ])('ignores %s outside production without touching Postgres', async (_, mode) => {
    const body = JSON.stringify({ ...JSON.parse(payload), ...mode });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(processStripeWebhook(body, sign(body))).resolves.toEqual({
        duplicateOrIgnored: true,
        code: 'stripe_livemode_mismatch',
      });
      expect(query).not.toHaveBeenCalled();
      expect(retrieveSubscription).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('applies a live-mode event in production', async () => {
    process.env.PRESSAY_DEPLOYMENT_ENV = 'production';
    process.env.ENTITLEMENT_SIGNING_KEY_ID = 'pressay-entitlement-production-2026-01';
    process.env.STRIPE_SECRET_KEY = 'rk_live_placeholder';
    clearEnvironmentCacheForTests();
    query
      .mockResolvedValueOnce([{ product_matches: true, customer_matches: true }])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    const body = JSON.stringify({ ...JSON.parse(payload), livemode: true });
    try {
      await expect(processStripeWebhook(body, sign(body))).resolves.toEqual({
        duplicateOrIgnored: false,
      });
      expect(retrieveSubscription).toHaveBeenCalledWith('sub_pressay_1');
    } finally {
      delete process.env.PRESSAY_DEPLOYMENT_ENV;
      delete process.env.ENTITLEMENT_SIGNING_KEY_ID;
      clearEnvironmentCacheForTests();
    }
  });

  it('rejects an invalid signature before touching Postgres', async () => {
    await expect(processStripeWebhook(payload, 't=1,v1=invalid')).rejects.toMatchObject(
      {
        status: 401,
        code: 'invalid_stripe_signature',
      },
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('never accepts a client-supplied Stripe Price ID', () => {
    expect(
      checkoutRequestSchema.safeParse({
        interval: 'month',
        acceptedTerms: true,
        immediatePerformanceConsent: true,
        termsVersion: '2026-08-10',
        priceId: 'price_attacker_controlled',
      }).success,
    ).toBe(false);
  });
});
