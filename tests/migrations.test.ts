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
});
