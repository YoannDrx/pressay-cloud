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

  it('accepts Windows devices without breaking five-argument macOS bootstraps', async () => {
    const migration = await readFile(
      new URL('../migrations/0021_windows_devices.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS pressay_device_platform_check',
    );
    expect(migration).toContain("CHECK (platform IN ('macos', 'windows'))");
    expect(migration).toContain("ALTER COLUMN platform SET DEFAULT 'macos'");
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS bootstrap_pressay_account(text, bytea, text, text, text);',
    );
    expect(migration).toContain('CREATE OR REPLACE FUNCTION bootstrap_pressay_account');
    expect(migration).toContain("p_platform text DEFAULT 'macos'");
    expect(migration).toContain('platform = EXCLUDED.platform');
    expect(migration).toContain(') >= 3 THEN');
    expect(migration).not.toMatch(/^\s*CREATE (TABLE|FUNCTION|INDEX) /m);
  });

  it('adds a transient, replayable Checkout lease per account', async () => {
    const migration = await readFile(
      new URL('../migrations/0022_billing_checkout_lease.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS billing_checkout_lease');
    expect(migration).toContain(
      'account_id uuid PRIMARY KEY REFERENCES pressay_account (id) ON DELETE CASCADE',
    );
    expect(migration).toContain('expires_at timestamptz NOT NULL');
  });

  it('adds support grants and a structured audit without personal data', async () => {
    const migration = await readFile(
      new URL('../migrations/0024_admin_support.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain(
      "CHECK (source IN ('invitation', 'referral', 'legacy', 'support'))",
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS target_account_id uuid');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS details jsonb');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS operations_request');
    expect(migration).toContain(') >= 3 THEN');
    expect(migration).not.toMatch(/^\s*CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/m);
    expect(migration).not.toMatch(/^\s*CREATE FUNCTION /m);
    expect(migration).not.toContain('account_contact');
  });

  it('links provider events to accounts without touching their payloads', async () => {
    const migration = await readFile(
      new URL('../migrations/0025_provider_event_account.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS account_id uuid');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS provider_event_failed_idx');
    expect(migration).toContain('FROM billing_financial_event financial');
    expect(migration).not.toMatch(/^\s*CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/m);
    expect(migration).not.toContain('payload_sha256');
  });

  it('stores subscription prices without changing existing rows', async () => {
    const migration = await readFile(
      new URL('../migrations/0026_subscription_price.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS amount_minor integer');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS currency text');
    expect(migration).not.toMatch(/^\s*(UPDATE|DELETE|DROP)\b/m);
  });

  it('records subscription status changes with a replayable trigger and no personal data', async () => {
    const migration = await readFile(
      new URL('../migrations/0028_subscription_transitions.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS billing_subscription_transition',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION record_pressay_subscription_transition()',
    );
    expect(migration).toContain(
      'DROP TRIGGER IF EXISTS billing_subscription_transition_trigger',
    );
    expect(migration).toContain(
      'AFTER INSERT OR UPDATE OF status ON billing_subscription',
    );
    expect(migration).toContain(
      'REFERENCES billing_subscription (id) ON DELETE CASCADE',
    );
    expect(migration).toContain('WHERE NOT EXISTS');
    expect(migration).not.toMatch(/^\s*CREATE (TABLE|INDEX) (?!IF NOT EXISTS)/m);
    expect(migration).not.toMatch(/^\s*CREATE FUNCTION /m);
    expect(migration).not.toMatch(/^\s*(UPDATE|DELETE|DROP TABLE|ALTER TABLE)\b/m);
    for (const column of ['email', 'amount_minor', 'provider_subscription_id'])
      expect(migration).not.toContain(column);
  });
});
