import { z } from 'zod';

import { getSql } from './client.js';

const schemaVersionRow = z.object({ schema_version: z.string().nullable() });

export interface DatabaseReadiness {
  ready: boolean;
  schemaVersion: string | null;
}

export async function databaseReadiness(): Promise<DatabaseReadiness> {
  try {
    const rows = await getSql().query(
      `SELECT max(name) AS schema_version
      FROM pressay_schema_migration`,
      [],
    );
    const parsed = schemaVersionRow.safeParse(rows[0] as unknown);
    const schemaVersion = parsed.success ? parsed.data.schema_version : null;
    return {
      ready: typeof schemaVersion === 'string',
      schemaVersion: typeof schemaVersion === 'string' ? schemaVersion : null,
    };
  } catch {
    return { ready: false, schemaVersion: null };
  }
}
