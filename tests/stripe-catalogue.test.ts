import { beforeEach, describe, expect, it } from 'vitest';

import { auditStripeCatalogue } from '../src/billing/catalog-audit.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';

const account = { id: 'acct_pressay' };
const product = {
  id: 'prod_pressay',
  active: true,
  name: 'Pressay Pro',
  livemode: false,
  tax_code: null,
};
const monthly = {
  id: 'price_monthly',
  active: true,
  product: product.id,
  currency: 'eur',
  unit_amount: 799,
  recurring: { interval: 'month' },
  tax_behavior: 'unspecified',
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
  tax_behavior: 'unspecified',
  type: 'recurring',
  livemode: false,
};
const portalConfiguration = {
  id: 'bpc_pressay',
  active: true,
  business_profile: {
    privacy_policy_url: 'https://press-say.app/en/privacy',
    terms_of_service_url: 'https://press-say.app/en/terms',
  },
};

function client(accountId = account.id) {
  return {
    accounts: { retrieveCurrent: () => Promise.resolve({ ...account, id: accountId }) },
    billingPortal: {
      configurations: { retrieve: () => Promise.resolve(portalConfiguration) },
    },
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
    delete process.env.STRIPE_TAX_READY;
    delete process.env.STRIPE_PRODUCT_TAX_CODE;
    delete process.env.STRIPE_PRICE_TAX_BEHAVIOR;
    process.env.STRIPE_EXPECTED_ACCOUNT_ID = account.id;
    process.env.STRIPE_PRODUCT_PRO = product.id;
    process.env.STRIPE_PRICE_PRO_MONTHLY = monthly.id;
    process.env.STRIPE_PRICE_PRO_ANNUAL = annual.id;
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = portalConfiguration.id;
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
      ...client(),
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

  it('rejects any recurring Price that could start a trial', async () => {
    const trialClient = {
      ...client(),
      prices: {
        retrieve: (id: string) =>
          Promise.resolve({
            ...(id === monthly.id ? monthly : annual),
            recurring: {
              ...(id === monthly.id ? monthly.recurring : annual.recurring),
              trial_period_days: 14,
            },
          }),
      },
    } as unknown as Parameters<typeof auditStripeCatalogue>[0];

    await expect(auditStripeCatalogue(trialClient)).rejects.toThrow(
      'does not match the Pressay catalogue',
    );
  });

  it('validates the product tax code and Price tax behavior once tax is approved', async () => {
    process.env.STRIPE_TAX_READY = 'true';
    process.env.STRIPE_PRODUCT_TAX_CODE = 'txcd_pressay';
    process.env.STRIPE_PRICE_TAX_BEHAVIOR = 'exclusive';
    clearEnvironmentCacheForTests();
    const taxClient = {
      ...client(),
      accounts: { retrieveCurrent: () => Promise.resolve(account) },
      products: {
        retrieve: () => Promise.resolve({ ...product, tax_code: 'txcd_pressay' }),
      },
      prices: {
        retrieve: (id: string) =>
          Promise.resolve({
            ...(id === monthly.id ? monthly : annual),
            tax_behavior: 'exclusive',
          }),
      },
    } as unknown as Parameters<typeof auditStripeCatalogue>[0];

    await expect(auditStripeCatalogue(taxClient)).resolves.toMatchObject({
      taxReady: true,
    });
  });

  it('rejects a Customer Portal without the reviewed legal links', async () => {
    const incompletePortalClient = {
      ...client(),
      billingPortal: {
        configurations: {
          retrieve: () =>
            Promise.resolve({
              ...portalConfiguration,
              business_profile: {
                privacy_policy_url: null,
                terms_of_service_url: null,
              },
            }),
        },
      },
    } as unknown as Parameters<typeof auditStripeCatalogue>[0];

    await expect(auditStripeCatalogue(incompletePortalClient)).rejects.toThrow(
      'reviewed Pressay legal links',
    );
  });
});
