import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const deleteStripeCustomer = vi.hoisted(() => vi.fn());

vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({ customers: { del: deleteStripeCustomer } }),
}));

import { runAccountDeletionBatch } from '../src/services/account-deletion.ts';

const job = {
  account_id: '95e286b8-8bf9-4cf6-bf73-fc09361dc88c',
  auth_user_id: 'auth-user-to-delete',
  stripe_customer_id: 'cus_to_delete',
  attempts: 1,
};

describe('account deletion worker', () => {
  beforeEach(() => {
    query.mockReset();
    deleteStripeCustomer.mockReset();
  });

  it('deletes the Stripe customer before cascading the local identity', async () => {
    query
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([{ id: job.auth_user_id }])
      .mockResolvedValueOnce([]);
    deleteStripeCustomer.mockResolvedValue({
      id: job.stripe_customer_id,
      deleted: true,
    });

    await expect(runAccountDeletionBatch()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    expect(deleteStripeCustomer).toHaveBeenCalledWith(job.stripe_customer_id);
    expect(query.mock.calls[1]?.[0]).toContain('DELETE FROM "user"');
  });

  it('keeps a retryable tombstone when provider cleanup fails', async () => {
    query
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    deleteStripeCustomer.mockRejectedValue(new Error('temporary provider failure'));

    await expect(runAccountDeletionBatch()).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 1,
    });
    expect(query.mock.calls[1]?.[0]).toContain("state = 'failed'");
    expect(JSON.stringify(query.mock.calls)).not.toContain(
      'temporary provider failure',
    );
  });
});
