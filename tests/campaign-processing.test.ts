import { beforeEach, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => vi.fn());
const createCoupon = vi.hoisted(() => vi.fn());
const createPromotion = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query }) }));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({
    coupons: { create: createCoupon },
    promotionCodes: { create: createPromotion },
  }),
}));
import { createCampaign } from '../src/services/operations.ts';
import { campaignSchema } from '../src/contracts/operations.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
const base = {
  kind: 'stripe_discount',
  reason: 'Recipe promotion',
  idempotencyKey: 'aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970',
};
beforeEach(() => {
  vi.resetAllMocks();
  process.env.DATABASE_URL = 'postgresql://example.test/test';
  process.env.PRESSAY_CAMPAIGN_SECRET =
    'campaign-test-only-secret-minimum-32-characters';
  process.env.STRIPE_PRODUCT_PRO = 'prod_pressay_test';
  clearEnvironmentCacheForTests();
  query.mockImplementation((sql: string) =>
    Promise.resolve(
      sql.includes('INSERT INTO access_campaign') ? [{ id: 'campaign' }] : [],
    ),
  );
  createCoupon.mockResolvedValue({ id: 'coupon_test' });
  createPromotion.mockResolvedValue({ id: 'promo_test' });
});
it.each([{ discountPercent: 25 }, { discountAmount: 500 }])(
  'bounds a promotion to one Pressay invoice: %j',
  async (discount) => {
    const input = campaignSchema.parse({ ...base, ...discount });
    const result = await createCampaign('actor', input, 'request');
    expect(result.secret).toMatch(/^[A-F0-9]{32}$/);
    expect(createCoupon).toHaveBeenCalledWith(
      expect.objectContaining({
        duration: 'once',
        applies_to: { products: ['prod_pressay_test'] },
        max_redemptions: 1,
        ...('discountPercent' in discount
          ? { percent_off: 25 }
          : { amount_off: 500, currency: 'eur' }),
      }),
      expect.objectContaining({
        idempotencyKey: `campaign/coupon/${result.id}`,
      }),
    );
    expect(createPromotion).toHaveBeenCalledWith(
      expect.objectContaining({
        promotion: { type: 'coupon', coupon: 'coupon_test' },
        code: result.secret,
        max_redemptions: 1,
      }),
      expect.objectContaining({
        idempotencyKey: `campaign/promotion/${result.id}`,
      }),
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain(result.secret);
  },
);
it('never creates a second Stripe promotion or reveals a secret for a reused request', async () => {
  query.mockResolvedValue([]);
  await expect(
    createCampaign(
      'actor',
      campaignSchema.parse({ ...base, discountPercent: 25 }),
      'request',
    ),
  ).rejects.toMatchObject({ code: 'campaign_already_created' });
  expect(createCoupon).not.toHaveBeenCalled();
});
it('records a recoverable failed campaign when Stripe cannot create its promotion', async () => {
  createPromotion.mockRejectedValue(new Error('network unavailable'));
  await expect(
    createCampaign(
      'actor',
      campaignSchema.parse({ ...base, discountPercent: 25 }),
      'request',
    ),
  ).rejects.toMatchObject({ code: 'campaign_creation_failed' });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("status='failed'"),
    expect.any(Array),
  );
});
