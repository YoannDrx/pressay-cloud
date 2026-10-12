import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));

import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { requestAccountDeletion } from '../src/services/accounts.ts';

describe('account deletion request with an App Store subscription', () => {
  beforeEach(() => {
    query.mockReset();
    process.env.DATABASE_URL = 'postgresql://example.test/pressay';
    clearEnvironmentCacheForTests();
  });

  it('refuses with a stable code while Apple may still bill the customer', async () => {
    query.mockResolvedValueOnce([{ active: true }]);
    await expect(requestAccountDeletion('auth-user')).rejects.toMatchObject({
      status: 409,
      code: 'apple_subscription_active',
      details: {
        manageSubscriptionsUrl: 'https://apps.apple.com/account/subscriptions',
      },
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("subscription.provider = 'app_store'");
    expect(query.mock.calls[0]?.[0]).toContain('cancel_at_period_end = false');
  });

  it('proceeds when the customer acknowledged the App Store subscription', async () => {
    query.mockResolvedValueOnce([]);
    await requestAccountDeletion('auth-user', { acknowledgeAppleSubscription: true });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain('request_pressay_account_deletion');
  });

  it('proceeds without asking when no Apple subscription is active', async () => {
    query.mockResolvedValueOnce([{ active: false }]).mockResolvedValueOnce([]);
    await requestAccountDeletion('auth-user');
    expect(query.mock.calls[1]?.[0]).toContain('request_pressay_account_deletion');
  });
});
