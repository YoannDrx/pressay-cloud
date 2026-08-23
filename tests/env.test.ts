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

  it('pins staging to a restricted Stripe test key', () => {
    expect(() =>
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_DEPLOYMENT_ENV: 'staging',
        STRIPE_SECRET_KEY: 'rk_live_placeholder',
      }),
    ).toThrow('staging must use a restricted test Stripe key');

    expect(() =>
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_DEPLOYMENT_ENV: 'staging',
        STRIPE_SECRET_KEY: 'sk_test_placeholder',
      }),
    ).toThrow('staging must use a restricted test Stripe key');

    expect(
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_DEPLOYMENT_ENV: 'staging',
        STRIPE_SECRET_KEY: 'rk_test_placeholder',
      }).STRIPE_SECRET_KEY,
    ).toBe('rk_test_placeholder');
  });

  it('binds canonical environments to their Vercel projects', () => {
    expect(() =>
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_DEPLOYMENT_ENV: 'staging',
        VERCEL: '1',
        VERCEL_PROJECT_ID: 'prj_wrong',
      }),
    ).toThrow('staging is bound to its canonical Vercel project');

    expect(
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_DEPLOYMENT_ENV: 'production',
        VERCEL: '1',
        VERCEL_PROJECT_ID: 'prj_wjK1Ur48HVNXiNwgoPJKilFoCHem',
      }).PRESSAY_DEPLOYMENT_ENV,
    ).toBe('production');
  });

  it('pins production to a restricted Stripe live key', () => {
    expect(() =>
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_DEPLOYMENT_ENV: 'production',
        STRIPE_SECRET_KEY: 'rk_test_placeholder',
      }),
    ).toThrow('production must use a restricted live Stripe key');

    expect(
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_DEPLOYMENT_ENV: 'production',
        STRIPE_SECRET_KEY: 'rk_live_placeholder',
      }).STRIPE_SECRET_KEY,
    ).toBe('rk_live_placeholder');
  });

  it('keeps commercial Stripe launch fail-closed without complete production config', () => {
    expect(() =>
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_DEPLOYMENT_ENV: 'staging',
        STRIPE_COMMERCIAL_LAUNCH_ENABLED: 'true',
      }),
    ).toThrow('commercial Stripe launch is allowed only in production');

    expect(() =>
      getEnvironment({
        DATABASE_URL: 'postgresql://example.test/pressay',
        PRESSAY_DEPLOYMENT_ENV: 'production',
        STRIPE_COMMERCIAL_LAUNCH_ENABLED: 'true',
      }),
    ).toThrow('STRIPE_SECRET_KEY is required');
  });
});
