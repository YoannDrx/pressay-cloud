import { beforeEach, describe, expect, it } from 'vitest';

import { auditStripeCatalogue } from '../src/billing/catalog-audit.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';

const account = { id: 'acct_pressay' };
const product = { id: 'prod_pressay', active: true, name: 'Pressay Pro' };
const monthly = {
  id: 'price_monthly',
  active: true,
  product: product.id,
  currency: 'eur',
  unit_amount: 799,
  recurring: { interval: 'month' },
  type: 'recurring',
};
const annual = {
  id: 'price_annual',
  active: true,
  product: product.id,
  currency: 'eur',
  unit_amount: 6900,
  recurring: { interval: 'year' },
  type: 'recurring',
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
});
