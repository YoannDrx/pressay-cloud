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
    clearEnvironmentCacheForTests();
  });

  it('uses the server-owned price and propagates idempotency', async () => {
    query
      .mockResolvedValueOnce([
        {
          account_id: '95e286b8-8bf9-4cf6-bf73-fc09361dc88c',
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
  });
});
