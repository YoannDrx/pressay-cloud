import { describe, expect, it } from 'vitest';

import { getEnvironment } from '../src/env.ts';

describe('environment', () => {
  it('normalizes an explicit origin allowlist', () => {
    const environment = getEnvironment({
      DATABASE_URL: 'postgresql://example.test/pressay',
      PRESSAY_ALLOWED_ORIGINS: 'https://press-say.app, http://localhost:1420/',
    });

    expect(environment.allowedOrigins).toEqual([
      'https://press-say.app',
      'http://localhost:1420',
    ]);
  });

  it('rejects non-Postgres database URLs', () => {
    expect(() => getEnvironment({ DATABASE_URL: 'https://example.test' })).toThrow();
  });

  it('requires Better Auth issuer and JWKS URL together', () => {
    expect(() =>
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_BETTER_AUTH_JWT_ISSUER: 'https://press-say.app',
      }),
    ).toThrow('Better Auth issuer and JWKS URL must be configured together');
  });
});
