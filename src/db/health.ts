import { getSql } from './client.js';

export async function databaseIsReady(): Promise<boolean> {
  try {
    const rows = await getSql().query('SELECT 1 AS ready', []);
    return rows[0]?.ready === 1;
  } catch {
    return false;
  }
}
