import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const createCustomer = vi.hoisted(() => vi.fn());
const createCheckoutSession = vi.hoisted(() => vi.fn());

vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({
    customers: { create: createCustomer },
    checkout: { sessions: { create: createCheckoutSession } },
  }),
}));

import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { createCheckout } from '../src/services/billing.ts';

describe('Stripe Checkout', () => {
  beforeEach(() => {
    query.mockReset();
    createCustomer.mockReset();
    createCheckoutSession.mockReset();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.STRIPE_COMMERCIAL_LAUNCH_ENABLED = 'true';
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
          trial_ends_at: null,
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
        customer: 'cus_pressay',
        line_items: [{ price: 'price_server_owned', quantity: 1 }],
      }),
      { idempotencyKey: 'checkout-idempotency-key' },
    );
    expect(createCheckoutSession.mock.calls[0]?.[0]).not.toHaveProperty(
      'payment_method_types',
    );
    expect(JSON.stringify(createCheckoutSession.mock.calls[0]?.[0])).toMatch(
      /"integration_identifier":"pressay_checkout_[a-z]{8}"/,
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
});
