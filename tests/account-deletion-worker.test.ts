import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const deleteStripeCustomer = vi.hoisted(() => vi.fn());
const deleteWebIdentity = vi.hoisted(() => vi.fn());

vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({ customers: { del: deleteStripeCustomer } }),
}));

vi.mock('../src/services/web-identity.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof WebIdentityModule>()),
  deleteWebIdentity,
}));

import type * as WebIdentityModule from '../src/services/web-identity.ts';
import { runAccountDeletionBatch } from '../src/services/account-deletion.ts';
import { WebIdentityDeletionError } from '../src/services/web-identity.ts';

const job = {
  account_id: '00000000-0000-4000-8000-000000000001',
  auth_user_id: 'auth-user-to-delete',
  stripe_customer_id: 'cus_to_delete',
  attempts: 1,
};

describe('account deletion worker', () => {
  beforeEach(() => {
    query.mockReset();
    deleteStripeCustomer.mockReset();
    deleteWebIdentity.mockReset();
    deleteWebIdentity.mockResolvedValue('deleted');
  });

  it('deletes the Stripe customer before cascading the local identity', async () => {
    query
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([{ completed: true }])
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
    expect(deleteWebIdentity).toHaveBeenCalledWith(job.auth_user_id);
    expect(query.mock.calls[1]?.[0]).toContain('complete_pressay_account_deletion');
  });

  it('completes when the web identity was already deleted', async () => {
    deleteWebIdentity.mockResolvedValue('absent');
    query
      .mockResolvedValueOnce([{ ...job, stripe_customer_id: null }])
      .mockResolvedValueOnce([{ completed: true }])
      .mockResolvedValueOnce([]);
    await expect(runAccountDeletionBatch()).resolves.toMatchObject({ completed: 1 });
    expect(deleteStripeCustomer).not.toHaveBeenCalled();
  });

  it('retries through the job backoff when the web identity deletion fails', async () => {
    deleteWebIdentity.mockRejectedValue(
      new WebIdentityDeletionError('web_identity_unavailable'),
    );
    deleteStripeCustomer.mockResolvedValue({ deleted: true });
    query
      .mockResolvedValueOnce([job])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(runAccountDeletionBatch()).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 1,
    });
    expect(query.mock.calls[1]?.[0]).toContain("state = 'failed'");
    expect(query.mock.calls[1]?.[1]).toContain('web_identity_unavailable');
    expect(JSON.stringify(query.mock.calls)).not.toContain(
      'complete_pressay_account_deletion',
    );
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
