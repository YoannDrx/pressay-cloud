import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

import { getEnvironment } from '../env.ts';

let sqlClient: NeonQueryFunction<false, false> | undefined;

export function getSql(): NeonQueryFunction<false, false> {
  sqlClient ??= neon(getEnvironment().DATABASE_URL, {
    fetchOptions: { cache: 'no-store' },
  });
  return sqlClient;
}

export function clearSqlClientForTests(): void {
  sqlClient = undefined;
}
