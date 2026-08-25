import type Stripe from 'stripe';

import { getEnvironment, requireEnvironmentValue } from '../env.js';
import { getStripe } from './stripe-client.js';

type StripeCatalogueClient = Pick<
  Stripe,
  'accounts' | 'billingPortal' | 'products' | 'prices'
>;

export interface StripeCatalogueAudit {
  accountId: string;
  productId: string;
  monthlyPriceId: string;
  annualPriceId: string;
  currency: string;
  livemode: boolean;
  taxReady: boolean;
  portalConfigurationId: string;
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
  const portalConfigurationId = requireEnvironmentValue(
    environment.STRIPE_PORTAL_CONFIGURATION_ID,
    'STRIPE_PORTAL_CONFIGURATION_ID',
  );
  const expectedLivemode = environment.PRESSAY_DEPLOYMENT_ENV === 'production';

  const [account, product, monthly, annual, portalConfiguration] = await Promise.all([
    // With no ID, Stripe returns the account represented by the API key. Using
    // retrieve(expectedAccountId) would be a Connect lookup and could validate
    // a connected account while the credential still belongs to another
    // platform account.
    stripe.accounts.retrieveCurrent(),
    stripe.products.retrieve(productId),
    stripe.prices.retrieve(monthlyPriceId),
    stripe.prices.retrieve(annualPriceId),
    stripe.billingPortal.configurations.retrieve(portalConfigurationId),
  ]);
  if (account.id !== expectedAccountId) {
    throw new Error('Stripe credentials do not belong to the expected Pressay account');
  }
  if (
    !product.active ||
    product.name !== 'Pressay Pro' ||
    product.livemode !== expectedLivemode
  ) {
    throw new Error('Stripe Product must be the active Pressay Pro catalogue entry');
  }
  if (
    !portalConfiguration.active ||
    portalConfiguration.business_profile.privacy_policy_url !==
      environment.STRIPE_PORTAL_PRIVACY_POLICY_URL ||
    portalConfiguration.business_profile.terms_of_service_url !==
      environment.STRIPE_PORTAL_TERMS_OF_SERVICE_URL
  ) {
    throw new Error(
      'Stripe Customer Portal must expose the reviewed Pressay legal links',
    );
  }
  if (
    environment.STRIPE_TAX_READY &&
    objectId(product.tax_code ?? '') !== environment.STRIPE_PRODUCT_TAX_CODE
  ) {
    throw new Error(
      'Stripe Product tax code does not match the verified tax configuration',
    );
  }

  for (const [label, price, interval, expectedAmount] of [
    ['monthly', monthly, 'month', environment.PRESSAY_PRO_MONTHLY_AMOUNT_MINOR],
    ['annual', annual, 'year', environment.PRESSAY_PRO_ANNUAL_AMOUNT_MINOR],
  ] as const) {
    if (
      !price.active ||
      price.livemode !== expectedLivemode ||
      objectId(price.product) !== product.id ||
      price.currency !== environment.PRESSAY_PRO_CURRENCY ||
      price.unit_amount !== expectedAmount ||
      price.recurring?.interval !== interval ||
      price.recurring.trial_period_days != null ||
      price.type !== 'recurring'
    ) {
      throw new Error(`Stripe ${label} Price does not match the Pressay catalogue`);
    }
    if (
      environment.STRIPE_TAX_READY &&
      price.tax_behavior !== environment.STRIPE_PRICE_TAX_BEHAVIOR
    ) {
      throw new Error(
        `Stripe ${label} Price tax behavior does not match the verified tax configuration`,
      );
    }
  }

  return {
    accountId: account.id,
    productId: product.id,
    monthlyPriceId: monthly.id,
    annualPriceId: annual.id,
    currency: environment.PRESSAY_PRO_CURRENCY,
    livemode: expectedLivemode,
    taxReady: environment.STRIPE_TAX_READY,
    portalConfigurationId,
  };
}
