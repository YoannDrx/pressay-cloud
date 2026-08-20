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
});
