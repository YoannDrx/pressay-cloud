import pg from 'pg';

import { getEnvironment, requireEnvironmentValue } from '../src/env.js';

const environment = getEnvironment();
const pool = new pg.Pool({
  connectionString: environment.DATABASE_URL_UNPOOLED ?? environment.DATABASE_URL,
  max: 1,
});
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(
    "UPDATE billing_product SET active = false, updated_at = now() WHERE provider = 'stripe'",
  );
  for (const [id, priceId, interval] of [
    [
      'stripe-pro-cloud-month',
      requireEnvironmentValue(
        environment.STRIPE_PRICE_PRO_MONTHLY,
        'STRIPE_PRICE_PRO_MONTHLY',
      ),
      'month',
    ],
    [
      'stripe-pro-cloud-year',
      requireEnvironmentValue(
        environment.STRIPE_PRICE_PRO_ANNUAL,
        'STRIPE_PRICE_PRO_ANNUAL',
      ),
      'year',
    ],
  ] as const) {
    await client.query(
      `INSERT INTO billing_product (
        id, provider, provider_product_id, provider_price_id,
        tier, billing_interval, active
      ) VALUES ($1, 'stripe', $2, $3, 'pro', $4, true)
      ON CONFLICT (id) DO UPDATE SET
        provider_product_id = EXCLUDED.provider_product_id,
        provider_price_id = EXCLUDED.provider_price_id,
        active = true,
        updated_at = now()`,
      [
        id,
        requireEnvironmentValue(environment.STRIPE_PRODUCT_PRO, 'STRIPE_PRODUCT_PRO'),
        priceId,
        interval,
      ],
    );
  }
  await client.query('COMMIT');
  console.log('Configured server-owned Stripe billing products.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
