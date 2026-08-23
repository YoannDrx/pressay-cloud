import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('database migrations', () => {
  it('allows Cloud accounts for subjects issued by the external identity service', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0012_decouple_cloud_account_identity.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS pressay_account_auth_user_id_fkey',
    );
  });

  it('stores financial lifecycle metadata without raw provider payloads', async () => {
    const migration = await readFile(
      new URL('../migrations/0013_billing_financial_events.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE billing_financial_event');
    expect(migration).toContain('Raw payloads and payment instruments are forbidden');
    expect(migration).not.toContain('jsonb');
  });

  it('preserves legacy access without carrying provider identifiers across accounts', async () => {
    const migration = await readFile(
      new URL('../migrations/0014_migrate_legacy_accounts.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain('FROM accounts AS legacy_account');
    expect(migration).toContain("WHEN is_trial THEN 'trial'");
    expect(migration).toContain("WHEN is_pro THEN 'support'");
    expect(migration).not.toContain('stripe_customer_id');
    expect(migration).not.toContain('stripe_subscription_id');
  });

  it('starts new native and web accounts on Free without consuming a web device slot', async () => {
    const migration = await readFile(
      new URL(
        '../migrations/0015_free_bootstrap_and_web_accounts.sql',
        import.meta.url,
      ),
      'utf8',
    );

    expect(migration).toContain('CREATE OR REPLACE FUNCTION bootstrap_pressay_account');
    expect(migration).toContain('CREATE FUNCTION bootstrap_pressay_web_account');
    expect(migration).toContain('INSERT INTO entitlement (account_id)');
    expect(migration).not.toContain("'14 days'");
    const webFunction = migration.split(
      'CREATE FUNCTION bootstrap_pressay_web_account',
    )[1];
    expect(webFunction).not.toContain('INSERT INTO pressay_device');
  });
});
