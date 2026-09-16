import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
const getSession = vi.hoisted(() => vi.fn());
const ownerAccount = vi.hoisted(() => vi.fn());
const createCampaign = vi.hoisted(() => vi.fn());
const consume = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const retrievePromotion = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query }) }));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({ promotionCodes: { retrieve: retrievePromotion } }),
}));
vi.mock('../src/auth.ts', () => ({ getAuth: () => ({ api: { getSession } }) }));
vi.mock('../src/services/accounts.ts', () => ({
  bootstrapWebAccount: vi.fn(),
  recordAccountContact: vi.fn(),
}));
vi.mock('../src/services/operations.ts', () => ({
  ownerAccount,
  createCampaign,
  accountId: () => Promise.resolve('account'),
}));
vi.mock('../src/services/rate-limits.ts', () => ({ consume }));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
const secret = 'operations-route-test-secret-minimum-32-characters';
async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({
    email: 'owner@example.test',
    email_verified: true,
    token_use: 'pressay_web_proxy',
    sid: 'web-session',
    pressay_step_up_method: 'totp',
    pressay_step_up_at: Math.floor(Date.now() / 1000),
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('stable-owner')
    .setIssuer('https://press-say.app/internal')
    .setAudience('pressay-api')
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(new TextEncoder().encode(secret));
}
const input = {
  kind: 'access_grant',
  reason: 'Private testing',
  idempotencyKey: 'aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970',
};
async function create(claims: Record<string, unknown> = {}) {
  return app.request('/v1/admin/campaigns', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await token(claims)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
}
describe('Cloud administrative authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://example.test/test';
    process.env.PRESSAY_INTERNAL_JWT_SECRET = secret;
    process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
    clearEnvironmentCacheForTests();
    getSession.mockResolvedValue(null);
    ownerAccount.mockResolvedValue('aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970');
    createCampaign.mockResolvedValue({ id: 'campaign' });
  });
  it('rejects anonymous requests', async () => {
    expect((await app.request('/v1/admin/session')).status).toBe(401);
  });
  it('rejects client-selected referral timestamps from a direct authenticated session', async () => {
    getSession.mockResolvedValue({
      user: { id: 'user', email: 'user@example.test', emailVerified: true },
      session: { id: 'session' },
    });
    const response = await app.request('/v1/referrals/attribute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'ABCDEF123456',
        issuedAt: Math.floor(Date.now() / 1000),
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('signed_referral_required');
  });
  it('requires a verified identity', async () => {
    expect((await create({ email_verified: false })).status).toBe(401);
    expect(createCampaign).not.toHaveBeenCalled();
  });
  it('does not infer admin rights from possession of a session', async () => {
    ownerAccount.mockResolvedValue(null);
    expect((await create()).status).toBe(403);
    expect(createCampaign).not.toHaveBeenCalled();
  });
  it.each([
    { pressay_step_up_at: 0 },
    { pressay_step_up_at: Math.floor(Date.now() / 1000) - 601 },
    { pressay_step_up_at: Math.floor(Date.now() / 1000) + 120 },
    { sid: '' },
    { pressay_step_up_method: 'password' },
  ])('rejects invalid step-up proof %j', async (claims) => {
    expect((await create(claims)).status).toBe(403);
    expect(createCampaign).not.toHaveBeenCalled();
  });
  it('accepts recent signed TOTP proof and validates defaults', async () => {
    expect((await create()).status).toBe(201);
    expect(consume).toHaveBeenCalledOnce();
    expect(createCampaign).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ durationDays: 30, maxRedemptions: 1 }),
      expect.any(String),
    );
  });
  it('returns live promotion usage without disclosing the reusable secret', async () => {
    query.mockResolvedValue([{ stripe_promotion_id: 'promo_example' }]);
    retrievePromotion.mockResolvedValue({
      times_redeemed: 3,
      max_redemptions: 5,
      active: true,
      code: 'NEVER_RETURN_THIS',
    });
    const response = await app.request(
      '/v1/admin/campaigns/aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970/usage',
      {
        headers: { authorization: `Bearer ${await token()}` },
      },
    );
    expect(response.status).toBe(200);
    const data: unknown = await response.json();
    expect(data).toMatchObject({ redemptions: 3, maximum: 5, active: true });
    expect(data).not.toHaveProperty('code');
    expect(retrievePromotion).toHaveBeenCalledWith(
      'promo_example',
      {},
      {
        timeout: 5000,
        maxNetworkRetries: 0,
      },
    );
  });
});
