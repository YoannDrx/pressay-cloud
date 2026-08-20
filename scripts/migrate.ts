import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import pg from 'pg';

import { getEnvironment } from '../src/env.js';

const migrationsDirectory = resolve(import.meta.dirname, '../migrations');
const advisoryLockId = 6_072_025_081_701;

async function migrate(): Promise<void> {
  const environment = getEnvironment();
  const connectionString =
    environment.DATABASE_URL_UNPOOLED ?? environment.DATABASE_URL;
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockId]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pressay_schema_migration (
        name text PRIMARY KEY,
        checksum_sha256 text NOT NULL CHECK (length(checksum_sha256) = 64),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();

    for (const file of migrationFiles) {
      const name = basename(file);
      const sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum_sha256: string }>(
        'SELECT checksum_sha256 FROM pressay_schema_migration WHERE name = $1',
        [name],
      );

      if (existing.rows[0]) {
        if (existing.rows[0].checksum_sha256 !== checksum) {
          throw new Error(`Deployed migration ${name} was modified`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO pressay_schema_migration (name, checksum_sha256) VALUES ($1, $2)',
          [name, checksum],
        );
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockId]);
    client.release();
    await pool.end();
  }
}

await migrate();
