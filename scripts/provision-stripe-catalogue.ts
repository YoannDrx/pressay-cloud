import type Stripe from 'stripe';

import { getStripe } from '../src/billing/stripe-client.js';
import { getEnvironment, requireEnvironmentValue } from '../src/env.js';

const environment = getEnvironment();
const stripe = getStripe();
const expectedAccountId = requireEnvironmentValue(
  environment.STRIPE_EXPECTED_ACCOUNT_ID,
  'STRIPE_EXPECTED_ACCOUNT_ID',
);
const account = await stripe.accounts.retrieveCurrent();
if (account.id !== expectedAccountId) {
  throw new Error('Stripe credentials do not belong to the expected Pressay account');
}

const products = await stripe.products.list({ limit: 100 });
const pressayProducts = products.data.filter(
  (product) => product.metadata.pressay_catalogue === 'pro-v1',
);
if (pressayProducts.length > 1) {
  throw new Error(
    'Multiple Pressay Pro v1 products exist; reconcile before provisioning',
  );
}
const product =
  pressayProducts[0] ??
  (await stripe.products.create(
    {
      name: 'Pressay Pro',
      description:
        'Advanced voice commands, custom modes, BYOK, encrypted sync and an explicit Pressay Cloud allowance.',
      active: true,
      metadata: {
        application: 'pressay',
        pressay_catalogue: 'pro-v1',
        privacy_posture: 'local-first',
      },
    },
    { idempotencyKey: 'pressay-pro-v1-product' },
  ));
if (!product.active || product.name !== 'Pressay Pro') {
  throw new Error('Existing Pressay Pro product is inactive or has an unexpected name');
}

const existingPrices = await stripe.prices.list({
  product: product.id,
  active: true,
  type: 'recurring',
  limit: 100,
});

async function ensurePrice(
  interval: 'month' | 'year',
  amount: number,
  lookupKey: string,
): Promise<Stripe.Price> {
  const matches = existingPrices.data.filter(
    (price) =>
      price.currency === environment.PRESSAY_PRO_CURRENCY &&
      price.unit_amount === amount &&
      price.recurring?.interval === interval,
  );
  if (matches.length > 1) {
    throw new Error(`Multiple matching ${interval} prices exist; reconcile manually`);
  }
  if (matches[0]) return matches[0];
  return stripe.prices.create(
    {
      product: product.id,
      currency: environment.PRESSAY_PRO_CURRENCY,
      unit_amount: amount,
      recurring: { interval },
      lookup_key: lookupKey,
      nickname: interval === 'month' ? 'Pressay Pro Monthly' : 'Pressay Pro Annual',
      metadata: { application: 'pressay', catalogue: 'pro-v1' },
    },
    { idempotencyKey: `pressay-pro-v1-${interval}-${amount}` },
  );
}

const monthly = await ensurePrice(
  'month',
  environment.PRESSAY_PRO_MONTHLY_AMOUNT_MINOR,
  'pressay_pro_monthly_v1',
);
const annual = await ensurePrice(
  'year',
  environment.PRESSAY_PRO_ANNUAL_AMOUNT_MINOR,
  'pressay_pro_annual_v1',
);

console.log(`STRIPE_EXPECTED_ACCOUNT_ID=${account.id}`);
console.log(`STRIPE_PRODUCT_PRO=${product.id}`);
console.log(`STRIPE_PRICE_PRO_MONTHLY=${monthly.id}`);
console.log(`STRIPE_PRICE_PRO_ANNUAL=${annual.id}`);
console.log(
  'Commercial checkout remains disabled until billing:audit and release tests pass.',
);
