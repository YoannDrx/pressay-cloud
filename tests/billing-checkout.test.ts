import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const createCustomer = vi.hoisted(() => vi.fn());
const createCheckoutSession = vi.hoisted(() => vi.fn());
const createPortalSession = vi.hoisted(() => vi.fn());

vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({
    customers: { create: createCustomer },
    checkout: { sessions: { create: createCheckoutSession } },
    billingPortal: { sessions: { create: createPortalSession } },
  }),
}));

import { clearEnvironmentCacheForTests } from '../src/env.ts';
import {
  createBillingPortal,
  createCheckout,
  getBillingStatus,
} from '../src/services/billing.ts';

describe('Stripe Checkout', () => {
  beforeEach(() => {
    query.mockReset();
    createCustomer.mockReset();
    createCheckoutSession.mockReset();
    createPortalSession.mockReset();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.PRESSAY_DEPLOYMENT_ENV = 'production';
    process.env.STRIPE_COMMERCIAL_LAUNCH_ENABLED = 'true';
    process.env.STRIPE_TAX_READY = 'true';
    process.env.STRIPE_AUTOMATIC_TAX_ENABLED = 'true';
    process.env.STRIPE_PRODUCT_TAX_CODE = 'txcd_pressay';
    process.env.STRIPE_PRICE_TAX_BEHAVIOR = 'exclusive';
    process.env.STRIPE_SECRET_KEY = 'rk_live_placeholder';
    process.env.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_pressay';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_placeholder';
    process.env.STRIPE_PRODUCT_PRO = 'prod_pressay';
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_monthly';
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_annual';
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = 'bpc_pressay';
    clearEnvironmentCacheForTests();
  });

  it('keeps Cloud Checkout closed behind the commercial release gate', async () => {
    process.env.STRIPE_COMMERCIAL_LAUNCH_ENABLED = 'false';
    clearEnvironmentCacheForTests();

    await expect(
      createCheckout(
        'auth-user',
        'person@example.com',
        'month',
        'checkout-idempotency-key',
        '2026-08-10',
        true,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: 'commercial_launch_not_enabled',
    });
    expect(query).not.toHaveBeenCalled();
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('uses the server-owned price and propagates idempotency', async () => {
    query
      .mockResolvedValueOnce([
        {
          account_id: '00000000-0000-4000-8000-000000000001',
          stripe_customer_id: null,
          provider_price_id: 'price_server_owned',
        },
      ])
      .mockResolvedValueOnce([]);
    createCustomer.mockResolvedValueOnce({ id: 'cus_pressay' });
    createCheckoutSession.mockResolvedValueOnce({
      url: 'https://checkout.stripe.com/c/pay/test',
    });

    await expect(
      createCheckout(
        'auth-user',
        'person@example.com',
        'month',
        'checkout-idempotency-key',
        '2026-08-10',
        true,
      ),
    ).resolves.toBe('https://checkout.stripe.com/c/pay/test');

    expect(createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        integration_identifier: 'pressay_direct_v1_vkmrqjtp',
        customer: 'cus_pressay',
        line_items: [{ price: 'price_server_owned', quantity: 1 }],
        automatic_tax: { enabled: true },
      }),
      {
        idempotencyKey:
          'pressay-checkout/00000000-0000-4000-8000-000000000001/69c4e343c7dbc4bb518ac785a37d919af0e1dea377cf57d063f70d52bb7dd9d4',
      },
    );
    expect(createCheckoutSession.mock.calls[0]?.[0]).not.toHaveProperty(
      'payment_method_types',
    );
    expect(JSON.stringify(createCheckoutSession.mock.calls[0]?.[0])).not.toContain(
      'trial_end',
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO billing_legal_acceptance'),
      [
        '00000000-0000-4000-8000-000000000001',
        'checkout-idempotency-key',
        '2026-08-10',
        true,
      ],
    );
  });

  it('pins Customer Portal sessions to the reviewed Pressay configuration', async () => {
    query.mockResolvedValueOnce([{ stripe_customer_id: 'cus_pressay' }]);
    createPortalSession.mockResolvedValueOnce({
      url: 'https://billing.stripe.com/p/session/test',
    });

    await expect(createBillingPortal('auth-user')).resolves.toBe(
      'https://billing.stripe.com/p/session/test',
    );
    expect(createPortalSession).toHaveBeenCalledWith({
      customer: 'cus_pressay',
      configuration: 'bpc_pressay',
      return_url: 'https://press-say.app/account',
    });
  });

  it('returns a server-authoritative subscription summary', async () => {
    query.mockResolvedValueOnce([
      {
        provider: 'stripe',
        billing_interval: 'year',
        status: 'active',
        current_period_ends_at: '2027-08-23T00:00:00.000Z',
        cancel_at_period_end: false,
      },
    ]);

    await expect(getBillingStatus('auth-user')).resolves.toEqual({
      provider: 'stripe',
      interval: 'year',
      status: 'active',
      currentPeriodEndsAt: '2027-08-23T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('(provider = entitlement.source) DESC'),
      ['auth-user'],
    );
  });

  it('returns an empty subscription summary for a Free account', async () => {
    query.mockResolvedValueOnce([
      {
        provider: null,
        billing_interval: null,
        status: null,
        current_period_ends_at: null,
        cancel_at_period_end: null,
      },
    ]);

    await expect(getBillingStatus('auth-user')).resolves.toEqual({
      provider: null,
      interval: null,
      status: null,
      currentPeriodEndsAt: null,
      cancelAtPeriodEnd: false,
    });
  });
});
