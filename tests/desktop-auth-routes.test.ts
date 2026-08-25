import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateOneTimeToken = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn());
const signInSocial = vi.hoisted(() => vi.fn());
const authHandler = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());

vi.mock('../src/auth.ts', () => ({
  getAuth: () => ({
    api: { generateOneTimeToken, getSession, signInSocial },
    handler: authHandler,
  }),
}));

vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));

import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';

const state = 'FodV_qJ3ShZVDZL8lOzCZHJTp0GwP16hecwgvMvZ7Sg';

describe('desktop authentication callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.PRESSAY_API_URL = 'https://api.press-say.app';
    process.env.BETTER_AUTH_SECRET = 'better-auth-secret-that-is-long-enough';
    delete process.env.RESEND_API_KEY;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.APPLE_CLIENT_ID;
    delete process.env.APPLE_TEAM_ID;
    delete process.env.APPLE_KEY_ID;
    delete process.env.APPLE_PRIVATE_KEY;
    clearEnvironmentCacheForTests();
    getSession.mockResolvedValue({
      user: { id: 'auth-user', email: 'person@example.com' },
      session: { id: 'session' },
    });
    generateOneTimeToken.mockResolvedValue({ token: 'single-use-secret' });
    authHandler.mockResolvedValue(new Response(null, { status: 204 }));
    query.mockResolvedValue([]);
    signInSocial.mockResolvedValue(
      new Response(
        JSON.stringify({
          redirect: false,
          url: 'https://appleid.apple.com/auth/authorize?state=provider-state',
        }),
        {
          headers: {
            'content-type': 'application/json',
            'set-cookie':
              '__Secure-better-auth.state=signed-state; Path=/; HttpOnly; Secure; SameSite=None',
          },
        },
      ),
    );
  });

  it('advertises only configured browser sign-in methods', async () => {
    const response = await app.request('/v1/desktop-auth/config');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      magicLink: false,
      providers: [],
      callbackUrl: 'https://api.press-say.app/v1/desktop-auth/callback',
    });
  });

  it('advertises a method only when all of its credentials are configured', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.GOOGLE_CLIENT_ID = 'google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
    clearEnvironmentCacheForTests();
    const response = await app.request('/v1/desktop-auth/config');
    expect(await response.json()).toMatchObject({
      magicLink: true,
      providers: ['google'],
    });
  });

  it('rejects a missing or malformed login state before creating a token', async () => {
    const response = await app.request('/v1/desktop-auth/callback?state=short');
    expect(response.status).toBe(422);
    expect(generateOneTimeToken).not.toHaveBeenCalled();
  });

  it('starts Apple in the browser and forwards the signed state cookie', async () => {
    const response = await app.request(`/v1/desktop-auth/social/apple?state=${state}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://appleid.apple.com/auth/authorize?state=provider-state',
    );
    expect(response.headers.get('set-cookie')).toContain(
      '__Secure-better-auth.state=signed-state',
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(signInSocial).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          provider: 'apple',
          callbackURL: `https://api.press-say.app/v1/desktop-auth/callback?state=${state}`,
          errorCallbackURL: `https://api.press-say.app/v1/desktop-auth/error?state=${state}`,
          disableRedirect: true,
        },
        asResponse: true,
      }),
    );
  });

  it('returns provider failures to the native app instead of the API root', async () => {
    const response = await app.request(`/v1/desktop-auth/error?state=${state}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `pressay://oauth/error?state=${state}`,
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('fails closed when the Apple state cookie cannot survive form_post', async () => {
    signInSocial.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          redirect: false,
          url: 'https://appleid.apple.com/auth/authorize?state=provider-state',
        }),
        {
          headers: {
            'content-type': 'application/json',
            'set-cookie':
              '__Secure-better-auth.state=signed-state; Path=/; HttpOnly; Secure; SameSite=Lax',
          },
        },
      ),
    );
    const response = await app.request(`/v1/desktop-auth/social/apple?state=${state}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_auth_provider_response' },
    });
  });

  it('rejects an authorization redirect outside Apple', async () => {
    signInSocial.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          redirect: false,
          url: 'https://appleid.apple.com.attacker.example/auth/authorize',
        }),
        {
          headers: {
            'content-type': 'application/json',
            'set-cookie':
              '__Secure-better-auth.state=signed-state; Path=/; HttpOnly; Secure; SameSite=None',
          },
        },
      ),
    );
    const response = await app.request(`/v1/desktop-auth/social/apple?state=${state}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_auth_provider_response' },
    });
  });

  it('returns an uncacheable deep link carrying a one-time token in the fragment', async () => {
    const response = await app.request(`/v1/desktop-auth/callback?state=${state}`, {
      headers: { cookie: 'better-auth.session_token=signed-session' },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `pressay://oauth/callback#token=single-use-secret&state=${state}`,
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(generateOneTimeToken).toHaveBeenCalledOnce();
  });

  it('does not mint a desktop token without an authenticated browser session', async () => {
    getSession.mockResolvedValueOnce(null);
    const response = await app.request(`/v1/desktop-auth/callback?state=${state}`);
    expect(response.status).toBe(401);
    expect(generateOneTimeToken).not.toHaveBeenCalled();
  });

  it('restores the signed state cookie only for the Apple form-post callback', async () => {
    const providerState = 'AppleProviderState_0123456789abcdef';
    query.mockResolvedValueOnce([
      {
        value: JSON.stringify({
          callbackURL: `https://api.press-say.app/v1/desktop-auth/callback?state=${state}`,
          oauthState: providerState,
        }),
      },
    ]);
    const response = await app.request('/v1/auth/callback/apple', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'pressay-existing=value; __Secure-better-auth.state=stale',
      },
      body: new URLSearchParams({ code: 'synthetic-code', state: providerState }),
    });

    expect(response.status).toBe(204);
    const forwarded = authHandler.mock.calls[0]?.[0] as Request;
    const cookie = forwarded.headers.get('cookie');
    expect(cookie).toContain('pressay-existing=value');
    expect(cookie).not.toContain('__Secure-better-auth.state=stale');
    expect(cookie).toContain(
      `__Secure-better-auth.state=${encodeURIComponent(`${providerState}.`)}`,
    );
  });

  it('does not restore a state created for a web callback', async () => {
    const providerState = 'AppleProviderState_0123456789abcdef';
    query.mockResolvedValueOnce([
      {
        value: JSON.stringify({
          callbackURL: 'https://press-say.app/account',
          oauthState: providerState,
        }),
      },
    ]);

    await app.request('/v1/auth/callback/apple', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: '__Secure-better-auth.state=web-cookie',
      },
      body: new URLSearchParams({ code: 'synthetic-code', state: providerState }),
    });

    const forwarded = authHandler.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('cookie')).toBe(
      '__Secure-better-auth.state=web-cookie',
    );
  });

  it('does not synthesize state for another provider callback', async () => {
    await app.request('/v1/auth/callback/google', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'pressay-existing=value',
      },
      body: new URLSearchParams({ code: 'synthetic-code', state }),
    });

    const forwarded = authHandler.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('cookie')).toBe('pressay-existing=value');
    expect(query).not.toHaveBeenCalled();
  });

  it('leaves a malformed Apple callback for Better Auth to reject', async () => {
    await app.request('/v1/auth/callback/apple', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'pressay-existing=value',
      },
      body: new URLSearchParams({ code: 'synthetic-code', state: 'short' }),
    });

    const forwarded = authHandler.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('cookie')).toBe('pressay-existing=value');
    expect(query).not.toHaveBeenCalled();
  });
});
