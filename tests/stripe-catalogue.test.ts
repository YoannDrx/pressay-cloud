import { beforeEach, describe, expect, it } from 'vitest';

import { auditStripeCatalogue } from '../src/billing/catalog-audit.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';

const account = { id: 'acct_pressay' };
const product = {
  id: 'prod_pressay',
  active: true,
  name: 'Pressay Pro',
  livemode: false,
};
const monthly = {
  id: 'price_monthly',
  active: true,
  product: product.id,
  currency: 'eur',
  unit_amount: 799,
  recurring: { interval: 'month' },
  type: 'recurring',
  livemode: false,
};
const annual = {
  id: 'price_annual',
  active: true,
  product: product.id,
  currency: 'eur',
  unit_amount: 6900,
  recurring: { interval: 'year' },
  type: 'recurring',
  livemode: false,
};

function client(accountId = account.id) {
  return {
    accounts: { retrieveCurrent: () => Promise.resolve({ ...account, id: accountId }) },
    products: { retrieve: () => Promise.resolve(product) },
    prices: {
      retrieve: (id: string) => Promise.resolve(id === monthly.id ? monthly : annual),
    },
  } as unknown as Parameters<typeof auditStripeCatalogue>[0];
}

describe('Stripe catalogue audit', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.PRESSAY_DEPLOYMENT_ENV = 'development';
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_COMMERCIAL_LAUNCH_ENABLED;
    process.env.STRIPE_EXPECTED_ACCOUNT_ID = account.id;
    process.env.STRIPE_PRODUCT_PRO = product.id;
    process.env.STRIPE_PRICE_PRO_MONTHLY = monthly.id;
    process.env.STRIPE_PRICE_PRO_ANNUAL = annual.id;
    clearEnvironmentCacheForTests();
  });

  it('accepts only the expected account, product and recurring prices', async () => {
    await expect(auditStripeCatalogue(client())).resolves.toMatchObject({
      accountId: account.id,
      productId: product.id,
      currency: 'eur',
    });
  });

  it('rejects credentials belonging to another Stripe business', async () => {
    await expect(auditStripeCatalogue(client('acct_routinekids'))).rejects.toThrow(
      'expected Pressay account',
    );
  });

  it('rejects a live catalogue in staging', async () => {
    process.env.PRESSAY_DEPLOYMENT_ENV = 'staging';
    clearEnvironmentCacheForTests();
    const liveProduct = { ...product, livemode: true };
    const liveClient = {
      accounts: { retrieveCurrent: () => Promise.resolve(account) },
      products: { retrieve: () => Promise.resolve(liveProduct) },
      prices: {
        retrieve: (id: string) =>
          Promise.resolve({
            ...(id === monthly.id ? monthly : annual),
            livemode: true,
          }),
      },
    } as unknown as Parameters<typeof auditStripeCatalogue>[0];

    await expect(auditStripeCatalogue(liveClient)).rejects.toThrow(
      'active Pressay Pro catalogue entry',
    );
  });

  it('requires a live catalogue in production', async () => {
    process.env.PRESSAY_DEPLOYMENT_ENV = 'production';
    clearEnvironmentCacheForTests();

    await expect(auditStripeCatalogue(client())).rejects.toThrow(
      'active Pressay Pro catalogue entry',
    );
  });
});
