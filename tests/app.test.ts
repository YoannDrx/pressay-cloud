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

describe('Pressay Cloud API', () => {
  beforeEach(() => {
    process.env.PRESSAY_ALLOWED_ORIGINS = 'https://press-say.app';
  });

  it('returns process health without touching user content', async () => {
    const response = await app.request('/v1/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: 'pressay-cloud',
      status: 'ok',
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

  it('returns a stable error envelope for unknown routes', async () => {
    const response = await app.request('/v1/missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'not_found' },
    });
  });
});
