import pg from 'pg';

import { getEnvironment, requireEnvironmentValue } from '../src/env.ts';

const environment = getEnvironment();
const pool = new pg.Pool({
  connectionString: environment.DATABASE_URL_UNPOOLED ?? environment.DATABASE_URL,
  max: 1,
});
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(
    "UPDATE billing_product SET active = false, updated_at = now() WHERE provider = 'app_store'",
  );
  for (const [id, productId, interval] of [
    [
      'app-store-pro-cloud-month',
      requireEnvironmentValue(
        environment.APP_STORE_PRODUCT_PRO_MONTHLY,
        'APP_STORE_PRODUCT_PRO_MONTHLY',
      ),
      'month',
    ],
    [
      'app-store-pro-cloud-year',
      requireEnvironmentValue(
        environment.APP_STORE_PRODUCT_PRO_ANNUAL,
        'APP_STORE_PRODUCT_PRO_ANNUAL',
      ),
      'year',
    ],
  ] as const) {
    await client.query(
      `INSERT INTO billing_product (
        id, provider, provider_product_id, provider_price_id,
        tier, billing_interval, active
      ) VALUES ($1, 'app_store', $2, $2, 'pro', $3, true)
      ON CONFLICT (id) DO UPDATE SET
        provider_product_id = EXCLUDED.provider_product_id,
        provider_price_id = EXCLUDED.provider_price_id,
        active = true,
        updated_at = now()`,
      [id, productId, interval],
    );
  }
  await client.query('COMMIT');
  console.log('Configured server-owned App Store billing products.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
