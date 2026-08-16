import { beforeEach, describe, expect, it } from 'vitest';

import { clearAuthForTests, getAuth } from '../src/auth.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';

describe('authentication configuration', () => {
  beforeEach(() => {
    clearAuthForTests();
    clearEnvironmentCacheForTests();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters';
    process.env.PRESSAY_API_URL = 'http://localhost:3000';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.APPLE_CLIENT_ID;
    delete process.env.APPLE_TEAM_ID;
    delete process.env.APPLE_KEY_ID;
    delete process.env.APPLE_PRIVATE_KEY;
  });

  it('creates an auth handler without optional social providers', () => {
    expect(getAuth().handler).toBeTypeOf('function');
  });

  it('rejects a partially configured Google provider', () => {
    process.env.GOOGLE_CLIENT_ID = 'partial-client';
    expect(() => getAuth()).toThrow(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together',
    );
  });

  it('rejects a partially configured Apple provider', () => {
    process.env.APPLE_CLIENT_ID = 'partial-client';
    expect(() => getAuth()).toThrow(
      'All Apple OAuth credentials must be configured together',
    );
  });
});
