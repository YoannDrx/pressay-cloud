import { generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUsage = vi.hoisted(() => vi.fn());
vi.mock('../src/services/accounts.ts', () => ({
  bootstrapAccount: vi.fn(),
  recordAccountContact: vi.fn(),
  bootstrapWebAccount: vi.fn(),
  getMe: vi.fn(),
  getUsage,
  listDevices: vi.fn(),
  requestAccountDeletion: vi.fn(),
  revokeDevice: vi.fn(),
}));

import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import {
  classifyJwtError,
  clearRemoteKeySetsForTests,
  verifyBearerToken,
} from '../src/lib/auth-middleware.ts';
import {
  configureTestIdentity,
  configureTestJwks,
  externalAccessToken,
  testApiAudience,
  webProxyToken,
} from './helpers/identity.ts';

async function rejectionReason(token: string): Promise<string> {
  try {
    await verifyBearerToken(token);
  } catch (error) {
    return classifyJwtError(error);
  }
  throw new Error('Expected the token to be rejected');
}

describe('bearer token verification', () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    delete process.env.PRESSAY_WEB_PROXY_LEGACY_AUDIENCE_ALLOWED;
    delete process.env.PRESSAY_WEB_PROXY_JWT_AUDIENCE;
    clearRemoteKeySetsForTests();
    configureTestIdentity();
    await configureTestJwks();
    getUsage.mockImplementation((id: string) => Promise.resolve({ subject: id }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts a web-issued OAuth access token without proxy privileges', async () => {
    const identity = await verifyBearerToken(
      await externalAccessToken({
        sid: 'session',
        pressay_step_up_method: 'totp',
        pressay_step_up_at: Math.floor(Date.now() / 1000),
        pressay_auth_at: Math.floor(Date.now() / 1000),
      }),
    );
    expect(identity).toMatchObject({
      id: 'auth-user',
      webProxy: false,
      stepUpAt: 0,
      signedInAt: 0,
    });
  });

  it('tolerates a trailing slash difference in the configured issuer', async () => {
    process.env.PRESSAY_BETTER_AUTH_JWT_ISSUER = 'https://id.example.test/';
    clearEnvironmentCacheForTests();
    await expect(verifyBearerToken(await externalAccessToken())).resolves.toMatchObject(
      {
        id: 'auth-user',
      },
    );
  });

  it.each([
    [
      'expired',
      () => externalAccessToken({}, { expiresAt: Math.floor(Date.now() / 1000) - 120 }),
    ],
    [
      'bad_audience',
      () => externalAccessToken({}, { audience: 'https://other.example' }),
    ],
    [
      'bad_issuer',
      () => externalAccessToken({}, { issuer: 'https://unknown.example' }),
    ],
    ['malformed', () => Promise.resolve('not-a-jwt')],
    ['email_unverified', () => externalAccessToken({ email_verified: false })],
  ])('classifies a %s token', async (reason, token) => {
    expect(await rejectionReason(await token())).toBe(reason);
  });

  it('classifies a token signed by an unknown key as a bad signature', async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    expect(
      await rejectionReason(await externalAccessToken({}, { key: privateKey })),
    ).toBe('bad_signature');
  });

  it('classifies an unreachable JWKS endpoint', async () => {
    clearRemoteKeySetsForTests();
    await configureTestJwks({ jwksStatus: 503 });
    expect(await rejectionReason(await externalAccessToken())).toBe(
      'jwks_fetch_failed',
    );
  });

  it('honours step-up proof only on the dedicated web proxy audience', async () => {
    const now = Math.floor(Date.now() / 1000);
    const proxy = await verifyBearerToken(
      await externalAccessToken(
        {
          token_use: 'pressay_web_proxy',
          sid: 'web-session',
          pressay_step_up_method: 'totp',
          pressay_step_up_at: now,
        },
        { audience: 'pressay-web-proxy' },
      ),
    );
    expect(proxy).toMatchObject({ webProxy: true, stepUpAt: now });
  });

  it('reads the session sign-in time only from web proxy tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const proxy = await verifyBearerToken(
      await externalAccessToken(
        { token_use: 'pressay_web_proxy', sid: 'web-session', pressay_auth_at: now },
        { audience: 'pressay-web-proxy' },
      ),
    );
    expect(proxy).toMatchObject({ webProxy: true, signedInAt: now, stepUpAt: 0 });
    const ignored = await verifyBearerToken(
      await externalAccessToken(
        { token_use: 'pressay_web_proxy', pressay_auth_at: String(now) },
        { audience: 'pressay-web-proxy' },
      ),
    );
    expect(ignored).toMatchObject({ webProxy: true, signedInAt: 0 });
  });

  it('rejects a proxy-audience token that does not declare proxy use', async () => {
    expect(
      await rejectionReason(
        await externalAccessToken({}, { audience: 'pressay-web-proxy' }),
      ),
    ).toBe('invalid_token_use');
  });

  it('rejects an OAuth access token carrying token_use once legacy proxies are retired', async () => {
    process.env.PRESSAY_WEB_PROXY_LEGACY_AUDIENCE_ALLOWED = 'false';
    clearEnvironmentCacheForTests();
    const token = await externalAccessToken(
      { token_use: 'pressay_web_proxy' },
      { audience: testApiAudience },
    );
    expect(await rejectionReason(token)).toBe('invalid_token_use');
  });

  it('still accepts legacy API-audience proxy tokens during the web rollout', async () => {
    const identity = await verifyBearerToken(
      await externalAccessToken({ token_use: 'pressay_web_proxy' }),
    );
    expect(identity.webProxy).toBe(true);
  });

  it('requires the proxy marker on HS256 internal tokens', async () => {
    expect(
      await rejectionReason(await webProxyToken('auth-user', { token_use: 'other' })),
    ).toBe('invalid_token_use');
  });

  it('returns a WWW-Authenticate reason and logs a code without the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const token = await externalAccessToken({}, { audience: 'https://other.example' });
    const response = await app.request('/v1/usage', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer realm="pressay-api", error="invalid_token", error_description="bad_audience"',
    );
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('"event":"auth.bearer_rejected"');
    expect(logged).toContain('"reason":"bad_audience"');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('person@example.com');
  });

  it('authenticates a valid route request', async () => {
    const response = await app.request('/v1/usage', {
      headers: { authorization: `Bearer ${await externalAccessToken()}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subject: 'auth-user' });
  });
});
