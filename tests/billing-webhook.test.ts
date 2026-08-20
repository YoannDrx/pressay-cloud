import Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));

import { clearStripeForTests } from '../src/billing/stripe-client.ts';
import { checkoutRequestSchema } from '../src/contracts/billing.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { processStripeWebhook } from '../src/services/billing.ts';

const signingSecret = 'whsec_test_signing_secret';
const stripe = new Stripe('sk_test_placeholder', {
  apiVersion: '2026-07-29.dahlia',
});
const payload = JSON.stringify({
  id: 'evt_pressay_subscription_1',
  object: 'event',
  api_version: '2026-07-29.dahlia',
  created: 1_786_924_800,
  type: 'customer.subscription.updated',
  data: {
    object: {
      id: 'sub_pressay_1',
      object: 'subscription',
      customer: 'cus_pressay_1',
      metadata: {
        pressay_account_id: '95e286b8-8bf9-4cf6-bf73-fc09361dc88c',
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

describe('Stripe webhook processing', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([]);
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
    process.env.STRIPE_WEBHOOK_SECRET = signingSecret;
    clearEnvironmentCacheForTests();
    clearStripeForTests();
  });

  it('verifies the untouched body before applying subscription metadata', async () => {
    query
      .mockResolvedValueOnce([{ id: 'stripe-pro-cloud-month' }])
      .mockResolvedValueOnce([{ state: 'applied' }]);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await expect(processStripeWebhook(payload, signature)).resolves.toEqual({
      duplicateOrIgnored: false,
    });
    expect(query).toHaveBeenCalledTimes(2);
    const serializedCall = JSON.stringify(query.mock.calls);
    expect(serializedCall).toContain('evt_pressay_subscription_1');
    expect(serializedCall).not.toContain(payload);
  });

  it('ignores a signed subscription event for a Price outside the active catalogue', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await expect(processStripeWebhook(payload, signature)).resolves.toEqual({
      duplicateOrIgnored: true,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('unconfigured_billing_product'),
      expect.arrayContaining(['evt_pressay_subscription_1']),
    );
  });

  it('ignores subscriptions containing more than one item', async () => {
    const parsed = JSON.parse(payload) as {
      data: { object: { items: { data: unknown[] } } };
    };
    parsed.data.object.items.data.push(parsed.data.object.items.data[0]);
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
      .mockResolvedValueOnce([{ id: 'stripe-pro-cloud-month' }])
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
    expect(query.mock.calls[2]?.[0]).toContain('billing_financial_event');
    expect(JSON.stringify(query.mock.calls)).not.toContain(invoicePayload);
  });

  it('records a full refund and projects a refunded entitlement state', async () => {
    const refundPayload = JSON.stringify({
      id: 'evt_pressay_refund_1',
      object: 'event',
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
    query.mockResolvedValueOnce([{ state: 'applied' }]);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: refundPayload,
      secret: signingSecret,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await expect(processStripeWebhook(refundPayload, signature)).resolves.toEqual({
      duplicateOrIgnored: false,
    });
    expect(query.mock.calls[0]?.[0]).toContain('billing_financial_event');
    expect(query.mock.calls[0]?.[1]).toContain('refunded');
    expect(query.mock.calls[0]?.[1]).toContain(true);
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
