import type Stripe from 'stripe';

import { getEnvironment, requireEnvironmentValue } from '../env.js';
import { getStripe } from './stripe-client.js';

type StripeCatalogueClient = Pick<Stripe, 'accounts' | 'products' | 'prices'>;

export interface StripeCatalogueAudit {
  accountId: string;
  productId: string;
  monthlyPriceId: string;
  annualPriceId: string;
  currency: string;
}

function objectId(value: string | { id: string }): string {
  return typeof value === 'string' ? value : value.id;
}

export async function auditStripeCatalogue(
  stripe: StripeCatalogueClient = getStripe(),
): Promise<StripeCatalogueAudit> {
  const environment = getEnvironment();
  const expectedAccountId = requireEnvironmentValue(
    environment.STRIPE_EXPECTED_ACCOUNT_ID,
    'STRIPE_EXPECTED_ACCOUNT_ID',
  );
  const productId = requireEnvironmentValue(
    environment.STRIPE_PRODUCT_PRO,
    'STRIPE_PRODUCT_PRO',
  );
  const monthlyPriceId = requireEnvironmentValue(
    environment.STRIPE_PRICE_PRO_MONTHLY,
    'STRIPE_PRICE_PRO_MONTHLY',
  );
  const annualPriceId = requireEnvironmentValue(
    environment.STRIPE_PRICE_PRO_ANNUAL,
    'STRIPE_PRICE_PRO_ANNUAL',
  );

  const [account, product, monthly, annual] = await Promise.all([
    // With no ID, Stripe returns the account represented by the API key. Using
    // retrieve(expectedAccountId) would be a Connect lookup and could validate
    // a connected account while the credential still belongs to another
    // platform account.
    stripe.accounts.retrieveCurrent(),
    stripe.products.retrieve(productId),
    stripe.prices.retrieve(monthlyPriceId),
    stripe.prices.retrieve(annualPriceId),
  ]);
  if (account.id !== expectedAccountId) {
    throw new Error('Stripe credentials do not belong to the expected Pressay account');
  }
  if (!product.active || product.name !== 'Pressay Pro') {
    throw new Error('Stripe Product must be the active Pressay Pro catalogue entry');
  }

  for (const [label, price, interval, expectedAmount] of [
    ['monthly', monthly, 'month', environment.PRESSAY_PRO_MONTHLY_AMOUNT_MINOR],
    ['annual', annual, 'year', environment.PRESSAY_PRO_ANNUAL_AMOUNT_MINOR],
  ] as const) {
    if (
      !price.active ||
      objectId(price.product) !== product.id ||
      price.currency !== environment.PRESSAY_PRO_CURRENCY ||
      price.unit_amount !== expectedAmount ||
      price.recurring?.interval !== interval ||
      price.type !== 'recurring'
    ) {
      throw new Error(`Stripe ${label} Price does not match the Pressay catalogue`);
    }
  }

  return {
    accountId: account.id,
    productId: product.id,
    monthlyPriceId: monthly.id,
    annualPriceId: annual.id,
    currency: environment.PRESSAY_PRO_CURRENCY,
  };
}
