import { randomUUID } from 'node:crypto';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { vi } from 'vitest';

import { clearEnvironmentCacheForTests } from '../../src/env.ts';

/** Test-only HS256 secret; never used outside local test processes. */
export const testInternalSecret = 'test-internal-secret-that-is-at-least-32-characters';
export const testInternalIssuer = 'https://press-say.app/internal';

/** Configure the web proxy trust path used by route tests. */
export function configureTestIdentity(): void {
  process.env.PRESSAY_INTERNAL_JWT_ISSUER = testInternalIssuer;
  process.env.PRESSAY_INTERNAL_JWT_SECRET = testInternalSecret;
  clearEnvironmentCacheForTests();
}

/** Sign a short-lived web proxy identity, as the web server does for its API proxy. */
export async function webProxyToken(
  subject = 'auth-user',
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({
    email: 'person@example.com',
    email_verified: true,
    token_use: 'pressay_web_proxy',
    sid: 'web-session',
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuer(testInternalIssuer)
    .setAudience('pressay-api')
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(new TextEncoder().encode(testInternalSecret));
}

export async function bearer(
  subject = 'auth-user',
  claims: Record<string, unknown> = {},
): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${await webProxyToken(subject, claims)}` };
}

export const testIssuer = 'https://id.example.test';
export const testApiAudience = 'https://api.example.test';

interface TestKeySet {
  privateKey: CryptoKey;
  jwksUrl: string;
}

let activeKeySet: TestKeySet | undefined;

/**
 * Configure the web OAuth issuer trust path with a local Ed25519 key. The JWKS
 * endpoint is served by a stubbed `fetch`; nothing leaves the test process.
 */
export async function configureTestJwks(
  options: { jwksStatus?: number } = {},
): Promise<TestKeySet> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: 'test-key',
    alg: 'EdDSA',
    use: 'sig',
  };
  const jwksUrl = `${testIssuer}/api/auth/jwks?test=${randomUUID()}`;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== jwksUrl) return Promise.reject(new TypeError('fetch failed'));
      if (options.jwksStatus && options.jwksStatus !== 200) {
        return Promise.resolve(
          new Response('unavailable', { status: options.jwksStatus }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  process.env.PRESSAY_BETTER_AUTH_JWT_ISSUER = testIssuer;
  process.env.PRESSAY_BETTER_AUTH_JWKS_URL = jwksUrl;
  process.env.PRESSAY_BETTER_AUTH_JWT_AUDIENCE = testApiAudience;
  clearEnvironmentCacheForTests();
  activeKeySet = { privateKey, jwksUrl };
  return activeKeySet;
}

/** Sign an access token as the web OAuth 2.1 issuer would for the macOS app. */
export async function externalAccessToken(
  claims: Record<string, unknown> = {},
  options: {
    subject?: string;
    issuer?: string;
    audience?: string | string[];
    expiresAt?: number;
    key?: CryptoKey;
  } = {},
): Promise<string> {
  const key = options.key ?? activeKeySet?.privateKey;
  if (!key) throw new Error('configureTestJwks() must run first');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: 'person@example.com', email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setSubject(options.subject ?? 'auth-user')
    .setIssuer(options.issuer ?? testIssuer)
    .setAudience(options.audience ?? testApiAudience)
    .setIssuedAt(now - 5)
    .setExpirationTime(options.expiresAt ?? now + 600)
    .sign(key);
}
