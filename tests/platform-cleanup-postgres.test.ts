import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REMOVE_IOS = '0032_remove_ios_devices.sql';
const DROP_WAITLIST = '0033_drop_waitlist.sql';

/** Migrations 0032 and 0033 against a real schema migrated up to 0031. */
describe.skipIf(!process.env.OPERATIONS_TEST_DATABASE_URL)(
  'removing the iPhone platform and the waitlists on PostgreSQL',
  () => {
    const schema = `platform_cleanup_${randomUUID().replaceAll('-', '')}`;
    const pool = new pg.Pool({
      connectionString: process.env.OPERATIONS_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let accountId: string;

    async function runMigration(file: string): Promise<void> {
      await pool.query(
        await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      );
    }
    function device(platform: string, appVariant: string) {
      return pool.query<{ id: string }>(
        `INSERT INTO pressay_device(account_id,device_identifier_hash,display_name,platform,app_variant,app_version)
        VALUES($1,$2,'Device',$3,$4,'1.0.0') RETURNING id`,
        [accountId, randomBytes(32), platform, appVariant],
      );
    }
    async function waitlistExists(): Promise<boolean> {
      const rows = await pool.query<{ name: string | null }>(
        `SELECT to_regclass('${schema}.waitlist_entry')::text AS name`,
      );
      return rows.rows[0]?.name != null;
    }

    beforeAll(async () => {
      await pool.query(`CREATE SCHEMA ${schema}`);
      const files = (await readdir(new URL('../migrations', import.meta.url)))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      expect(files.slice(-2)).toEqual([REMOVE_IOS, DROP_WAITLIST]);
      for (const file of files.slice(0, -2)) await runMigration(file);
      const account = await pool.query<{ id: string }>(
        'INSERT INTO pressay_account(auth_user_id) VALUES($1) RETURNING id',
        [`subject-${randomUUID()}`],
      );
      accountId = String(account.rows[0]?.id);
    });
    afterAll(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    });

    it('refuses to run while an iPhone device exists, without touching it', async () => {
      const iphone = await device('ios', 'app_store_ios');
      await expect(runMigration(REMOVE_IOS)).rejects.toThrow('ios_devices_remain');
      // The failed migration left the device and the 0031 checks in place.
      expect(
        (
          await pool.query('SELECT platform FROM pressay_device WHERE id=$1', [
            iphone.rows[0]?.id,
          ])
        ).rows,
      ).toEqual([{ platform: 'ios' }]);
      await pool.query('DELETE FROM pressay_device WHERE id=$1', [iphone.rows[0]?.id]);
    });

    it('then accepts only Mac and Windows devices, and replays safely', async () => {
      await device('macos', 'direct');
      await device('macos', 'mas');
      await device('windows', 'direct');
      await runMigration(REMOVE_IOS);
      await runMigration(REMOVE_IOS);

      await expect(device('ios', 'app_store_ios')).rejects.toMatchObject({
        code: '23514',
      });
      await expect(device('macos', 'app_store_ios')).rejects.toMatchObject({
        code: '23514',
      });
      await expect(device('windows', 'mas')).resolves.toBeDefined();
      expect(
        (
          await pool.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM pressay_device',
          )
        ).rows[0]?.count,
      ).toBe(4);
      // The bootstrap function still registers a desktop device.
      await expect(
        pool.query(
          `SELECT * FROM bootstrap_pressay_account($1,$2,'PC','direct','1.0.0','windows')`,
          [`subject-${randomUUID()}`, randomBytes(32)],
        ),
      ).resolves.toBeDefined();
    });

    it('drops the waitlist table, and replays safely', async () => {
      expect(await waitlistExists()).toBe(true);
      await pool.query(
        `INSERT INTO waitlist_entry(email,platform,locale,source,consent_at)
        VALUES('someone@example.test','ios','fr','landing',now())`,
      );
      await runMigration(DROP_WAITLIST);
      expect(await waitlistExists()).toBe(false);
      await runMigration(DROP_WAITLIST);
      expect(await waitlistExists()).toBe(false);
    });
  },
);
