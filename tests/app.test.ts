import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/health.ts', () => ({
  databaseReadiness: vi.fn(() =>
    Promise.resolve({
      ready: true,
      schemaVersion: '0013_billing_financial_events.sql',
    }),
  ),
}));

import app from '../src/app.ts';
import { databaseReadiness } from '../src/db/health.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';

describe('Pressay Cloud API', () => {
  beforeEach(() => {
    process.env.PRESSAY_ALLOWED_ORIGINS = 'https://press-say.app';
    process.env.PRESSAY_DEPLOYMENT_ENV = 'staging';
    clearEnvironmentCacheForTests();
  });

  it('returns process health without touching user content', async () => {
    const response = await app.request('/v1/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: 'pressay-cloud',
      status: 'ok',
      environment: 'staging',
    });
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('returns readiness when Neon responds', async () => {
    const response = await app.request('/v1/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      checks: {
        database: 'up',
        schemaVersion: '0013_billing_financial_events.sql',
      },
    });
  });

  it('does not reflect an untrusted CORS origin', async () => {
    const response = await app.request('/v1/health', {
      headers: { Origin: 'https://attacker.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts an allowlisted origin configured with a trailing slash and allows PATCH', async () => {
    process.env.PRESSAY_ALLOWED_ORIGINS =
      'https://Press-Say.app/ , https://admin.example.test';
    const response = await app.request('/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://press-say.app',
        'Access-Control-Request-Method': 'PATCH',
      },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://press-say.app',
    );
    expect(response.headers.get('access-control-allow-methods')).toContain('PATCH');
    const rejected = await app.request('/v1/health', {
      headers: { Origin: 'https://press-say.app.attacker.example' },
    });
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('logs the error class, a stable code, the route pattern and the cause chain', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const databaseError = Object.assign(
      new Error('connection to customer@example.com failed', {
        cause: new TypeError('fetch failed'),
      }),
      { code: '08006' },
    );
    vi.mocked(databaseReadiness).mockRejectedValueOnce(databaseError);

    const response = await app.request('/v1/ready', {
      headers: { 'x-request-id': 'request-id-for-test-0001' },
    });
    expect(response.status).toBe(500);
    const entry = JSON.parse(String(errorLog.mock.calls.at(-1)?.[0])) as Record<
      string,
      unknown
    >;
    expect(entry).toMatchObject({
      event: 'request.failed',
      code: 'internal_error',
      error_code: 'database_08006',
      error_name: 'Error',
      cause_chain: 'Error>TypeError',
      method: 'GET',
      route: '/v1/ready',
      status: 500,
    });
    expect(JSON.stringify(entry)).not.toContain('example.com');
    errorLog.mockRestore();
  });

  it('returns a stable error envelope for unknown routes', async () => {
    const response = await app.request('/v1/missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'not_found' },
    });
  });
});
