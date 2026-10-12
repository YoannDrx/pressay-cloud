import { beforeEach, describe, expect, it } from 'vitest';

import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';

const state = 'FodV_qJ3ShZVDZL8lOzCZHJTp0GwP16hecwgvMvZ7Sg';

describe('desktop authentication through the single web issuer', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.PRESSAY_API_URL = 'https://api.press-say.app';
    process.env.PRESSAY_BETTER_AUTH_JWT_ISSUER = 'https://press-say.app/';
    process.env.PRESSAY_BETTER_AUTH_JWKS_URL = 'https://press-say.app/api/auth/jwks';
    process.env.PRESSAY_BETTER_AUTH_JWT_AUDIENCE = 'https://api.press-say.app';
    // Even if legacy Cloud OAuth credentials linger in an environment, they
    // must not create a second identity provider.
    process.env.GOOGLE_CLIENT_ID = 'legacy-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'legacy-google-secret';
    process.env.RESEND_API_KEY = 're_legacy';
    clearEnvironmentCacheForTests();
  });

  it('advertises the web issuer and both providers through the PKCE flow', async () => {
    const response = await app.request('/v1/desktop-auth/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      magicLink: false,
      providers: ['apple', 'google'],
      callbackUrl: 'pressay://oauth/callback',
      flow: 'web_oauth_pkce',
      issuer: 'https://press-say.app',
      authorizationServerMetadataUrl:
        'https://press-say.app/.well-known/oauth-authorization-server',
      clientId: 'w9ckUgrcFp7H7wNV',
      resource: 'https://api.press-say.app',
      providerHintParameter: 'provider',
    });
  });

  it.each([
    `/v1/desktop-auth/social/apple?state=${state}`,
    `/v1/desktop-auth/social/google?state=${state}`,
    `/v1/desktop-auth/callback?state=${state}`,
    `/v1/desktop-auth/error?state=${state}`,
    '/v1/auth/callback/apple',
    '/v1/auth/get-session',
  ])('retires the Cloud-hosted sign-in route %s', async (path) => {
    const response = await app.request(path);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: { code: 'desktop_auth_moved_to_web' },
    });
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each(['/v1/auth/sign-in/magic-link', '/v1/auth/one-time-token/verify'])(
    'retires Cloud magic links and one-time desktop tokens (%s)',
    async (path) => {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.com' }),
      });
      expect(response.status).toBe(410);
    },
  );
});
