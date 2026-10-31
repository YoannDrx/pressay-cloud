import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const createCustomer = vi.hoisted(() => vi.fn());
const createCheckoutSession = vi.hoisted(() => vi.fn());
const updateCustomer = vi.hoisted(() => vi.fn());
const listSubscriptions = vi.hoisted(() => vi.fn());
const listCheckoutSessions = vi.hoisted(() => vi.fn());
const expireCheckoutSession = vi.hoisted(() => vi.fn());

vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({
    customers: { create: createCustomer, update: updateCustomer },
    subscriptions: { list: listSubscriptions },
    checkout: {
      sessions: {
        create: createCheckoutSession,
        list: listCheckoutSessions,
        expire: expireCheckoutSession,
      },
    },
  }),
}));

import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { createCheckout, getBillingStatus } from '../src/services/billing.ts';

const accountId = '00000000-0000-4000-8000-000000000001';

/**
 * Route SQL by statement instead of call order: the checkout context, the
 * per-account lease (held in `leases`, like the real table) and writes.
 */
function mockDatabase(
  context: Record<string, unknown>,
  leases = new Map<string, string>(),
): Map<string, string> {
  query.mockImplementation((sql: string, parameters: unknown[] = []) => {
    if (sql.includes('FROM pressay_account a')) return Promise.resolve([context]);
    if (sql.includes('INSERT INTO billing_checkout_lease')) {
      const [account, leaseId] = parameters as [string, string];
      if (leases.has(account)) return Promise.resolve([]);
      leases.set(account, leaseId);
      return Promise.resolve([{ lease_id: leaseId }]);
    }
    if (sql.includes('DELETE FROM billing_checkout_lease')) {
      const [account, leaseId] = parameters as [string, string];
      if (leases.get(account) === leaseId) leases.delete(account);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
  return leases;
}

function freeContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: accountId,
    stripe_customer_id: 'cus_existing',
    provider_price_id: 'price_server_owned',
    ...overrides,
  };
}

function openSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cs_open',
    mode: 'subscription',
    url: 'https://checkout.stripe.com/c/pay/open',
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
    metadata: { pressay_account_id: accountId, pressay_price_id: 'price_server_owned' },
    ...overrides,
  };
}

function checkout(
  key = 'checkout-idempotency-key',
  interval: 'month' | 'year' = 'month',
) {
  return createCheckout(
    'auth-user',
    'person@example.com',
    interval,
    key,
    '2026-08-10',
    true,
  );
}

describe('Stripe Checkout', () => {
  beforeEach(() => {
    query.mockReset();
    createCustomer.mockReset();
    createCheckoutSession.mockReset();
    updateCustomer.mockReset();
    listSubscriptions.mockReset();
    listCheckoutSessions.mockReset();
    expireCheckoutSession.mockReset();
    listSubscriptions.mockResolvedValue({ data: [] });
    listCheckoutSessions.mockResolvedValue({ data: [] });
    delete process.env.STRIPE_AUTOMATIC_TAX_ENABLED;
    delete process.env.STRIPE_TAX_ID_COLLECTION_ENABLED;
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.PRESSAY_DEPLOYMENT_ENV = 'production';
    process.env.ENTITLEMENT_SIGNING_KEY_ID = 'pressay-entitlement-production-2026-01';
    process.env.STRIPE_COMMERCIAL_LAUNCH_ENABLED = 'true';
    process.env.STRIPE_SECRET_KEY = 'rk_live_placeholder';
    process.env.STRIPE_EXPECTED_ACCOUNT_ID = 'acct_pressay';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_placeholder';
    process.env.STRIPE_PRODUCT_PRO = 'prod_pressay';
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_monthly';
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_annual';
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
    const leases = mockDatabase(freeContext({ stripe_customer_id: null }));
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
      }),
      {
        idempotencyKey:
          'pressay-checkout/00000000-0000-4000-8000-000000000001/69c4e343c7dbc4bb518ac785a37d919af0e1dea377cf57d063f70d52bb7dd9d4',
      },
    );
    expect(createCheckoutSession.mock.calls[0]?.[0]).toMatchObject({
      metadata: {
        pressay_account_id: '00000000-0000-4000-8000-000000000001',
        pressay_price_id: 'price_server_owned',
      },
    });
    expect(leases.size).toBe(0);
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

  it.each([
    [{ stripe_subscription_active: true }, 'subscription_already_active'],
    [{ apple_subscription_active: true }, 'apple_subscription_active'],
  ])('refuses a second subscription (%j)', async (flags, code) => {
    query.mockResolvedValueOnce([
      {
        account_id: '00000000-0000-4000-8000-000000000001',
        stripe_customer_id: 'cus_pressay',
        provider_price_id: 'price_server_owned',
        ...flags,
      },
    ]);
    await expect(
      createCheckout(
        'auth-user',
        'person@example.com',
        'year',
        'checkout-idempotency-key',
        '2026-08-10',
        true,
      ),
    ).rejects.toMatchObject({ status: 409, code });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("apple_environment = 'Production'");
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('enables Stripe Tax and address collection behind the release flag', async () => {
    process.env.STRIPE_AUTOMATIC_TAX_ENABLED = 'true';
    process.env.STRIPE_TAX_ID_COLLECTION_ENABLED = 'true';
    clearEnvironmentCacheForTests();
    mockDatabase(
      freeContext({
        stripe_subscription_active: false,
        apple_subscription_active: false,
      }),
    );
    updateCustomer.mockResolvedValueOnce({ id: 'cus_existing' });
    createCheckoutSession.mockResolvedValueOnce({
      url: 'https://checkout.stripe.com/c/pay/test',
    });

    await createCheckout(
      'auth-user',
      'person@example.com',
      'month',
      'checkout-idempotency-key',
      '2026-08-10',
      true,
    );

    expect(updateCustomer).toHaveBeenCalledWith('cus_existing', {
      email: 'person@example.com',
    });
    expect(createCheckoutSession.mock.calls[0]?.[0]).toMatchObject({
      customer: 'cus_existing',
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      tax_id_collection: { enabled: true },
    });
  });

  it('keeps Checkout tax-neutral while Stripe Tax is not configured', async () => {
    mockDatabase(freeContext());
    createCheckoutSession.mockResolvedValueOnce({
      url: 'https://checkout.stripe.com/c/pay/test',
    });
    await createCheckout(
      'auth-user',
      'person@example.com',
      'month',
      'checkout-idempotency-key',
      '2026-08-10',
      true,
    );
    const params = createCheckoutSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('automatic_tax');
    expect(params).not.toHaveProperty('customer_update');
  });

  it('refuses a second Checkout while another one is being created for the account', async () => {
    mockDatabase(freeContext(), new Map([[accountId, 'other-request-lease']]));

    await expect(checkout()).rejects.toMatchObject({
      status: 409,
      code: 'checkout_in_progress',
    });
    expect(listSubscriptions).not.toHaveBeenCalled();
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE billing_checkout_lease.expires_at <= now()'),
      [accountId, expect.any(String), 90],
    );
  });

  it('lets only one of two concurrent requests create a Checkout Session', async () => {
    mockDatabase(freeContext());
    let releaseStripe: () => void = () => undefined;
    listSubscriptions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStripe = () => resolve({ data: [] });
        }),
    );
    createCheckoutSession.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/pay/first',
    });

    const first = checkout('checkout-idempotency-key-tab-1');
    await vi.waitFor(() => expect(listSubscriptions).toHaveBeenCalledOnce());
    const second = checkout('checkout-idempotency-key-tab-2');
    await expect(second).rejects.toMatchObject({ code: 'checkout_in_progress' });
    releaseStripe();
    await expect(first).resolves.toBe('https://checkout.stripe.com/c/pay/first');
    expect(createCheckoutSession).toHaveBeenCalledOnce();
  });

  it('reuses the open Checkout Session for the same Price instead of creating one', async () => {
    const leases = mockDatabase(freeContext());
    listCheckoutSessions.mockResolvedValueOnce({ data: [openSession()] });

    await expect(checkout('checkout-idempotency-key-tab-2')).resolves.toBe(
      'https://checkout.stripe.com/c/pay/open',
    );
    expect(listCheckoutSessions).toHaveBeenCalledWith({
      customer: 'cus_existing',
      status: 'open',
      limit: 100,
    });
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(expireCheckoutSession).not.toHaveBeenCalled();
    expect(leases.size).toBe(0);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO billing_legal_acceptance'),
      [accountId, 'checkout-idempotency-key-tab-2', '2026-08-10', true],
    );
  });

  it.each([
    [
      'another Price',
      { metadata: { pressay_account_id: accountId, pressay_price_id: 'price_other' } },
    ],
    ['no Pressay metadata', { metadata: {} }],
    ['an imminent expiry', { expires_at: Math.floor(Date.now() / 1000) + 60 }],
  ])(
    'expires an open Checkout Session with %s before creating a new one',
    async (_, overrides) => {
      mockDatabase(freeContext());
      listCheckoutSessions.mockResolvedValueOnce({ data: [openSession(overrides)] });
      expireCheckoutSession.mockResolvedValueOnce({ id: 'cs_open', status: 'expired' });
      createCheckoutSession.mockResolvedValueOnce({
        url: 'https://checkout.stripe.com/c/pay/new',
      });

      await expect(checkout()).resolves.toBe('https://checkout.stripe.com/c/pay/new');
      expect(expireCheckoutSession).toHaveBeenCalledWith('cs_open');
      expect(expireCheckoutSession.mock.invocationCallOrder[0]).toBeLessThan(
        createCheckoutSession.mock.invocationCallOrder[0] ?? 0,
      );
    },
  );

  it('creates nothing when an open Checkout Session can no longer be expired', async () => {
    const leases = mockDatabase(freeContext());
    listCheckoutSessions.mockResolvedValueOnce({
      data: [openSession({ metadata: { pressay_account_id: accountId } })],
    });
    expireCheckoutSession.mockRejectedValueOnce(
      Object.assign(new Error('session is not open'), {
        type: 'StripeInvalidRequestError',
      }),
    );

    await expect(checkout()).rejects.toMatchObject({
      status: 409,
      code: 'checkout_in_progress',
    });
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(leases.size).toBe(0);
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid'])(
    'refuses Checkout when Stripe already bills a %s subscription not yet in Postgres',
    async (status) => {
      const leases = mockDatabase(freeContext());
      listSubscriptions.mockResolvedValueOnce({ data: [{ id: 'sub_live', status }] });

      await expect(checkout()).rejects.toMatchObject({
        status: 409,
        code: 'subscription_already_active',
      });
      expect(listSubscriptions).toHaveBeenCalledWith({
        customer: 'cus_existing',
        limit: 100,
      });
      expect(listCheckoutSessions).not.toHaveBeenCalled();
      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(leases.size).toBe(0);
    },
  );

  it.each(['incomplete_expired', 'canceled'])(
    'allows Checkout when the only Stripe subscription is %s',
    async (status) => {
      mockDatabase(freeContext());
      listSubscriptions.mockResolvedValueOnce({ data: [{ id: 'sub_old', status }] });
      createCheckoutSession.mockResolvedValueOnce({
        url: 'https://checkout.stripe.com/c/pay/new',
      });
      await expect(checkout()).resolves.toBe('https://checkout.stripe.com/c/pay/new');
    },
  );

  it('releases the lease when Stripe fails', async () => {
    const leases = mockDatabase(freeContext());
    createCheckoutSession.mockRejectedValueOnce(new Error('stripe unavailable'));
    await expect(checkout()).rejects.toThrow('stripe unavailable');
    expect(leases.size).toBe(0);
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
