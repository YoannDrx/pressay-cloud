import { jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { deleteWebIdentity } from '../src/services/web-identity.ts';

const secret = 'test-internal-secret-that-is-at-least-32-characters';
const fetchMock = vi.fn<typeof fetch>();

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input ?? '';
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('cloud to web identity deletion', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    process.env.PRESSAY_DEPLOYMENT_ENV = 'staging';
    process.env.PRESSAY_INTERNAL_JWT_SECRET = secret;
    process.env.PRESSAY_BETTER_AUTH_JWT_ISSUER = 'https://web.example.test/';
    process.env.PRESSAY_BETTER_AUTH_JWKS_URL = 'https://web.example.test/api/auth/jwks';
    delete process.env.PRESSAY_WEB_INTERNAL_ORIGIN;
    delete process.env.PRESSAY_CLOUD_INTERNAL_JWT_ISSUER;
    clearEnvironmentCacheForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts a short-lived HS256 token bound to the subject and an idempotent body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ deleted: true }));
    await expect(deleteWebIdentity('web-user-1')).resolves.toBe('deleted');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      'https://web.example.test/api/internal/identity-deletion',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(init?.body as string)).toEqual({
      userId: 'web-user-1',
      reason: 'account_deleted',
    });
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    const { payload, protectedHeader } = await jwtVerify(
      authorization.replace(/^Bearer /, ''),
      new TextEncoder().encode(secret),
      {
        issuer: 'https://api.press-say.app/internal',
        audience: 'pressay-web-internal',
        algorithms: ['HS256'],
      },
    );
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.sub).toBe('web-user-1');
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
  });

  it('treats an already deleted identity as success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ deleted: false }));
    await expect(deleteWebIdentity('web-user-1')).resolves.toBe('absent');
  });

  it('honours an explicit internal origin and issuer override', async () => {
    process.env.PRESSAY_WEB_INTERNAL_ORIGIN =
      'https://internal.example.test/ignored/path';
    process.env.PRESSAY_CLOUD_INTERNAL_JWT_ISSUER =
      'https://api-staging.example.test/internal';
    clearEnvironmentCacheForTests();
    fetchMock.mockResolvedValueOnce(jsonResponse({ deleted: true }));
    await deleteWebIdentity('web-user-1');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(url)).toBe(
      'https://internal.example.test/api/internal/identity-deletion',
    );
    const token = (new Headers(init?.headers).get('authorization') ?? '').slice(7);
    await expect(
      jwtVerify(token, new TextEncoder().encode(secret), {
        issuer: 'https://api-staging.example.test/internal',
        audience: 'pressay-web-internal',
      }),
    ).resolves.toBeTruthy();
  });

  it.each([
    [401, 'web_identity_unauthorized'],
    [400, 'web_identity_bad_request'],
    [503, 'web_identity_unavailable'],
  ])('maps HTTP %i to the retryable code %s', async (status, code) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'details never logged' }, status),
    );
    await expect(deleteWebIdentity('web-user-1')).rejects.toMatchObject({ code });
  });

  it('maps a network failure to a retryable code', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(deleteWebIdentity('web-user-1')).rejects.toMatchObject({
      code: 'web_identity_unreachable',
    });
  });

  it('rejects a malformed success body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(deleteWebIdentity('web-user-1')).rejects.toMatchObject({
      code: 'web_identity_bad_response',
    });
  });

  it('fails closed outside development when the web endpoint is not configured', async () => {
    delete process.env.PRESSAY_INTERNAL_JWT_SECRET;
    clearEnvironmentCacheForTests();
    await expect(deleteWebIdentity('web-user-1')).rejects.toMatchObject({
      code: 'web_identity_deletion_not_configured',
    });
    process.env.PRESSAY_DEPLOYMENT_ENV = 'development';
    clearEnvironmentCacheForTests();
    await expect(deleteWebIdentity('web-user-1')).resolves.toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
