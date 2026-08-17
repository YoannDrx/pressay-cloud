import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.hoisted(() => vi.fn());
const restoreAppStorePurchase = vi.hoisted(() => vi.fn());
const processAppleWebhook = vi.hoisted(() => vi.fn());

vi.mock('../src/auth.ts', () => ({
  getAuth: () => ({
    api: { getSession },
    handler: vi.fn(),
  }),
}));
vi.mock('../src/services/apple-billing.ts', () => ({
  restoreAppStorePurchase,
  processAppleWebhook,
}));

import app from '../src/app.ts';

describe('App Store billing routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({
      user: { id: 'auth-user', email: 'person@example.com' },
      session: { id: 'session' },
    });
  });

  it('requires idempotency before restoring a signed transaction', async () => {
    const response = await app.request('/v1/billing/restore-app-store', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedTransaction: `ey.${'a'.repeat(80)}.signature` }),
    });
    expect(response.status).toBe(422);
    expect(restoreAppStorePurchase).not.toHaveBeenCalled();
  });

  it('accepts the raw Apple V2 envelope without a user session', async () => {
    processAppleWebhook.mockResolvedValue({ duplicateOrIgnored: false });
    const rawBody = JSON.stringify({
      signedPayload: `ey.${'b'.repeat(80)}.signature`,
    });
    const response = await app.request('/v1/webhooks/apple', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });
    expect(response.status).toBe(200);
    expect(processAppleWebhook).toHaveBeenCalledWith(rawBody);
  });
});
