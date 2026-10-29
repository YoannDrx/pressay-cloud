import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordDownloadEvent = vi.hoisted(() => vi.fn());
vi.mock('../src/services/downloads.ts', () => ({ recordDownloadEvent }));

import app from '../src/app.ts';
import { clearRemoteKeySetsForTests } from '../src/lib/auth-middleware.ts';
import {
  configureTestJwks,
  externalAccessToken,
  webProxyToken,
  configureTestIdentity,
} from './helpers/identity.ts';

const event = () => ({
  anonymousID: randomUUID(),
  platform: 'macos',
  assetType: 'dmg',
  appVersion: '2.0.0-beta.5',
  source: 'website',
});

async function post(body: unknown, authorization?: string) {
  return app.request('/v1/downloads', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

const serviceToken = (
  claims: Record<string, unknown> = {},
  audience = 'pressay-download-event',
) =>
  externalAccessToken(
    { token_use: 'pressay_download_event', ...claims },
    { subject: 'press-say.app', audience },
  );

describe('download events', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    clearRemoteKeySetsForTests();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    configureTestIdentity();
    await configureTestJwks();
  });

  it('records a download reported by the web server', async () => {
    const body = event();
    const response = await post(body, `Bearer ${await serviceToken()}`);
    expect(response.status).toBe(202);
    expect(recordDownloadEvent).toHaveBeenCalledWith(body);
  });

  it('rejects anonymous callers and tokens minted for another purpose', async () => {
    expect((await post(event())).status).toBe(401);
    const mac = await externalAccessToken();
    expect((await post(event(), `Bearer ${mac}`)).status).toBe(401);
    const proxy = await webProxyToken();
    expect((await post(event(), `Bearer ${proxy}`)).status).toBe(401);
    const wrongUse = await serviceToken({ token_use: 'pressay_web_proxy' });
    expect((await post(event(), `Bearer ${wrongUse}`)).status).toBe(401);
    const wrongAudience = await serviceToken({}, 'pressay-web-proxy');
    expect((await post(event(), `Bearer ${wrongAudience}`)).status).toBe(401);
    expect(recordDownloadEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed events and assets that do not match the platform', async () => {
    const authorization = `Bearer ${await serviceToken()}`;
    for (const body of [
      { ...event(), assetType: 'exe' },
      { ...event(), platform: 'windows' },
      { ...event(), anonymousID: 'not-a-uuid' },
      { ...event(), source: 'x'.repeat(65) },
      { ...event(), source: '<script>' },
      { ...event(), appVersion: 'latest' },
      { ...event(), ip: '203.0.113.1' },
    ]) {
      expect((await post(body, authorization)).status).toBe(422);
    }
    expect(recordDownloadEvent).not.toHaveBeenCalled();
  });

  it('accepts a Windows installer', async () => {
    const body = {
      ...event(),
      platform: 'windows',
      assetType: 'exe',
      campaign: 'launch',
    };
    const response = await post(body, `Bearer ${await serviceToken()}`);
    expect(response.status).toBe(202);
  });
});
