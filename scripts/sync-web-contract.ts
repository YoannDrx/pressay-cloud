import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const web = process.argv[2];
if (!web)
  throw new Error('Usage: tsx scripts/sync-web-contract.ts <web-repository> [--check]');
const source = await readFile(
  new URL('../src/contracts/operations-wire.ts', import.meta.url),
  'utf8',
);
const target = resolve(web, 'lib/operations-contract.ts');
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== source)
    throw new Error('Web/Cloud contract drift');
} else await writeFile(target, source);
