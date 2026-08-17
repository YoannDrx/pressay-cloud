import Stripe from 'stripe';

import { getEnvironment, requireEnvironmentValue } from '../env.js';

let stripeClient: Stripe | undefined;

export function getStripe(): Stripe {
  stripeClient ??= new Stripe(
    requireEnvironmentValue(getEnvironment().STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY'),
    {
      apiVersion: '2026-07-29.dahlia',
      appInfo: { name: 'Pressay Cloud', version: '0.1.0' },
      maxNetworkRetries: 2,
      timeout: 20_000,
    },
  );
  return stripeClient;
}

export function clearStripeForTests(): void {
  stripeClient = undefined;
}
