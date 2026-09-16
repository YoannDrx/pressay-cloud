import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
const query = vi.hoisted(() => vi.fn());
const createBalanceTransaction = vi.hoisted(() => vi.fn());
const listInvoices = vi.hoisted(() => vi.fn());
const listPayments = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query }) }));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({
    customers: { createBalanceTransaction },
    invoices: { list: listInvoices },
    invoicePayments: { list: listPayments },
  }),
}));
import {
  captureReferralEvent,
  runReferralRewards,
  referralCredit,
} from '../src/services/referrals.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
const now = Math.floor(Date.now() / 1000);
const invoice = (id: string, paidAt: number) => ({
  id,
  object: 'invoice',
  livemode: false,
  currency: 'eur',
  amount_paid: 799,
  customer: 'cus_test',
  created: paidAt,
  status_transitions: { paid_at: paidAt },
  parent: { subscription_details: { subscription: 'sub_test' } },
});
beforeEach(() => {
  vi.resetAllMocks();
  process.env.DATABASE_URL = 'postgresql://example.test/test';
  process.env.PRESSAY_DEPLOYMENT_ENV = 'development';
  process.env.PRESSAY_REFERRALS_ENABLED = 'true';
  clearEnvironmentCacheForTests();
});
describe('referral payment processing', () => {
  it('calculates the annual thirty-day credit to the nearest cent', () => {
    expect(referralCredit('year', 799, 6900)).toBe(567);
    expect(referralCredit('month', 799, 6900)).toBe(799);
  });
  it('does not reward Sandbox events in production', async () => {
    process.env.PRESSAY_DEPLOYMENT_ENV = 'production';
    clearEnvironmentCacheForTests();
    await captureReferralEvent({
      type: 'invoice.paid',
      livemode: false,
      data: { object: invoice('in_test', now) },
    } as unknown as Stripe.Event);
    expect(query).not.toHaveBeenCalled();
  });
  it('resolves the first real payment despite a renewal webhook arriving first', async () => {
    query
      .mockResolvedValueOnce([{ id: 'account' }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{ provider_subscription_id: 'sub_test' }])
      .mockResolvedValue([]);
    listInvoices.mockReturnValue(
      (function* () {
        yield invoice('in_renewal', now);
        yield invoice('in_first', now - 86400);
      })(),
    );
    listPayments.mockResolvedValue({
      data: [
        { livemode: false, payment: { type: 'payment_intent' }, amount_paid: 799 },
      ],
    });
    await captureReferralEvent({
      type: 'invoice.paid',
      livemode: false,
      data: { object: invoice('in_renewal', now) },
    } as unknown as Stripe.Event);
    expect(listPayments).toHaveBeenCalledWith({
      invoice: 'in_first',
      status: 'paid',
      limit: 100,
    });
    expect(query.mock.calls.at(-1)?.[1]).toEqual([
      'in_first',
      'account',
      now - 86400,
      799,
      'eur',
      799,
      6900,
    ]);
  });
  it('ignores fully credited or out-of-band invoices', async () => {
    query
      .mockResolvedValueOnce([{ id: 'account' }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{ provider_subscription_id: 'sub_test' }]);
    listInvoices.mockReturnValue(
      (function* () {
        yield invoice('in_credit', now);
      })(),
    );
    listPayments.mockResolvedValue({
      data: [
        { livemode: false, payment: { type: 'payment_record' }, amount_paid: 799 },
      ],
    });
    await captureReferralEvent({
      type: 'invoice.paid',
      livemode: false,
      data: { object: invoice('in_credit', now) },
    } as unknown as Stripe.Event);
    expect(
      query.mock.calls.some((call) =>
        String(call[0]).includes('record_pressay_referral_payment'),
      ),
    ).toBe(false);
  });
  it('uses a stable Stripe idempotency key and the frozen price across retries', async () => {
    query
      .mockResolvedValueOnce([
        {
          id: 'reward',
          kind: 'credit',
          customer_id: 'cus_test',
          amount_minor: 567,
          attempts: 2,
          created_at: new Date().toISOString(),
        },
      ])
      .mockResolvedValueOnce([{}])
      .mockResolvedValue([]);
    createBalanceTransaction.mockResolvedValue({ id: 'cbtxn_test' });
    expect(await runReferralRewards(1)).toEqual({ processed: 1 });
    expect(createBalanceTransaction).toHaveBeenCalledWith(
      'cus_test',
      expect.objectContaining({ amount: -567, currency: 'eur' }),
      { idempotencyKey: 'referral/reward/reward', timeout: 8000, maxNetworkRetries: 0 },
    );
  });
  it('sends uncertain old writes for manual reconciliation instead of duplicating credit', async () => {
    query
      .mockResolvedValueOnce([
        {
          id: 'reward',
          kind: 'credit',
          attempts: 2,
          created_at: new Date(Date.now() - 25 * 3600000).toISOString(),
        },
      ])
      .mockResolvedValue([]);
    await runReferralRewards(1);
    expect(createBalanceTransaction).not.toHaveBeenCalled();
    expect(String(query.mock.calls[1]?.[0])).toContain("status='review'");
  });
});
