import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';

import { getEnvironment } from '../src/env.js';

const migrationsDirectory = resolve(import.meta.dirname, '../migrations');
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort();
const expected = migrationFiles.at(-1);
if (!expected) throw new Error('No database migration exists');

const environment = getEnvironment();
const pool = new pg.Pool({
  connectionString: environment.DATABASE_URL_UNPOOLED ?? environment.DATABASE_URL,
  max: 1,
});

try {
  const result = await pool.query<{ name: string }>(
    'SELECT name FROM pressay_schema_migration ORDER BY name DESC LIMIT 1',
  );
  const actual = result.rows[0]?.name;
  if (actual !== expected) {
    throw new Error(
      `Database schema is ${actual ?? 'unmigrated'}; expected ${expected}`,
    );
  }
  console.log(`Verified database schema ${expected}.`);
} finally {
  await pool.end();
}
