import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
const operationsMember = vi.hoisted(() => vi.fn());
const createCampaign = vi.hoisted(() => vi.fn());
const consume = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const retrievePromotion = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({ getSql: () => ({ query }) }));
vi.mock('../src/billing/stripe-client.ts', () => ({
  getStripe: () => ({ promotionCodes: { retrieve: retrievePromotion } }),
}));
vi.mock('../src/services/accounts.ts', () => ({
  bootstrapWebAccount: vi.fn(),
  recordAccountContact: vi.fn(),
}));
vi.mock('../src/services/operations.ts', () => ({
  operationsMember,
  createCampaign,
  audit,
  accountId: () => Promise.resolve('account'),
}));
vi.mock('../src/services/rate-limits.ts', () => ({ consume }));
import app from '../src/app.ts';
import { clearEnvironmentCacheForTests } from '../src/env.ts';
import { configureTestJwks, externalAccessToken } from './helpers/identity.ts';
const secret = 'operations-route-test-secret-minimum-32-characters';
async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({
    email: 'owner@example.test',
    email_verified: true,
    token_use: 'pressay_web_proxy',
    sid: 'web-session',
    pressay_step_up_method: 'totp',
    pressay_step_up_at: Math.floor(Date.now() / 1000),
    pressay_two_factor: true,
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
function member(role: 'owner' | 'support' | 'readonly') {
  operationsMember.mockResolvedValue({
    accountId: 'aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970',
    role,
    claimed: false,
  });
}
async function call(method: string, path: string, body?: unknown, claims = {}) {
  return app.request(`/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token(claims)}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const ID = 'aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970';
describe('Cloud administrative authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://example.test/test';
    process.env.PRESSAY_INTERNAL_JWT_SECRET = secret;
    process.env.PRESSAY_INTERNAL_JWT_ISSUER = 'https://press-say.app/internal';
    clearEnvironmentCacheForTests();
    member('owner');
    createCampaign.mockResolvedValue({ id: 'campaign' });
  });
  it('rejects anonymous requests', async () => {
    expect((await app.request('/v1/admin/session')).status).toBe(401);
  });
  it('rejects client-selected referral timestamps from a direct authenticated session', async () => {
    await configureTestJwks();
    const response = await app.request('/v1/referrals/attribute', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await externalAccessToken()}`,
        'content-type': 'application/json',
      },
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
    operationsMember.mockResolvedValue(null);
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
  it.each([
    '/v1/admin/users',
    '/v1/admin/referrals',
    '/v1/admin/users/aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970',
    '/v1/admin/users/aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970?include=identity',
    '/v1/admin/audit-log',
    '/v1/admin/audit-log?action=grant&reads=exclude',
    '/v1/admin/billing/financial-events?kind=refund',
  ])('requires a recent second factor to read personal data at %s', async (path) => {
    const response = await app.request(path, {
      headers: { authorization: `Bearer ${await token({ pressay_step_up_at: 0 })}` },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'step_up_required' },
    });
    expect(query).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it.each([
    ['/v1/admin/users/aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970/grants', { days: 30 }],
    ['/v1/admin/grants/aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970/extend', { days: 30 }],
    ['/v1/admin/devices/aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970/revoke', {}],
    ['/v1/admin/devices/aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970/restore', {}],
    ['/v1/admin/users/aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970/deletion', {}],
    ['/v1/admin/billing/events/stripe/evt_123/replay', {}],
    [
      '/v1/admin/audit/external',
      {
        action: 'user.sessions.revoke',
        targetAccountId: 'aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970',
        result: 'requested',
      },
    ],
  ])(
    'requires a recent second factor for the support action %s',
    async (path, extra) => {
      const response = await app.request(path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await token({ pressay_step_up_at: 0 })}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          idempotencyKey: 'aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970',
          reason: 'Support ticket',
          ...extra,
        }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'step_up_required' },
      });
      expect(query).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    },
  );
  it('refuses a support action without a reason before any change', async () => {
    const response = await app.request(
      '/v1/admin/users/aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970/grants',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await token()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          idempotencyKey: 'aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970',
          days: 30,
        }),
      },
    );
    expect(response.status).toBe(422);
    expect(query).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it('audits an administrative read of the user list without storing the search', async () => {
    query.mockResolvedValue([]);
    const response = await app.request('/v1/admin/users?search=someone', {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      'aa72ef7f-a1a3-4cd9-ae1d-7cbf08a38970',
      'admin.users.read',
      'users',
      'personal_data_read',
      expect.any(String),
      'succeeded',
      { targetAccountId: null },
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('someone');
    expect(consume).not.toHaveBeenCalled();
  });
  it('keeps aggregate admin reads available without a second factor', async () => {
    query.mockResolvedValue([]);
    const response = await app.request('/v1/admin/session', {
      headers: { authorization: `Bearer ${await token({ pressay_step_up_at: 0 })}` },
    });
    expect(response.status).toBe(200);
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
  it('requires an Authenticator app on the web account of every administrator', async () => {
    const response = await call('GET', 'admin/session', undefined, {
      pressay_two_factor: false,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'two_factor_required' },
    });
    // The flag only counts when it is exactly true.
    expect(
      (await call('GET', 'admin/session', undefined, { pressay_two_factor: 'true' }))
        .status,
    ).toBe(403);
    expect(operationsMember).toHaveBeenCalledWith(
      'stable-owner',
      'owner@example.test',
      true,
      false,
    );
  });
  it('tells a non-administrator apart from a member without Authenticator', async () => {
    operationsMember.mockResolvedValue(null);
    const response = await call('GET', 'admin/session', undefined, {
      pressay_two_factor: false,
    });
    expect(await response.json()).toMatchObject({ error: { code: 'admin_required' } });
  });
  it.each(['owner', 'support', 'readonly'] as const)(
    'returns the %s role to the web',
    async (role) => {
      member(role);
      const response = await call('GET', 'admin/session', undefined, {
        pressay_step_up_at: 0,
      });
      expect(await response.json()).toEqual({ role, accountId: ID });
    },
  );
  it('keeps a read-only member away from every action', async () => {
    member('readonly');
    for (const [method, path, body] of [
      ['POST', 'admin/campaigns', input],
      ['POST', `admin/users/${ID}/grants`, { ...input, days: 30 }],
      ['POST', `admin/devices/${ID}/revoke`, input],
      ['POST', 'admin/members', { ...input, email: 'a@example.test', role: 'support' }],
      [
        'PATCH',
        'admin/gates/direct/tax',
        { reason: 'Checked', status: 'passed', evidence: 'x' },
      ],
    ] as const) {
      const response = await call(method, path, body);
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'role_forbidden' },
      });
    }
    expect(createCampaign).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    // Reads stay available.
    query.mockResolvedValue([]);
    expect((await call('GET', 'admin/users')).status).toBe(200);
  });
  it('lets support help customers but not touch billing or roles', async () => {
    member('support');
    expect((await call('POST', 'admin/campaigns', input)).status).toBe(201);
    const promotion = await call('POST', 'admin/campaigns', {
      ...input,
      kind: 'stripe_discount',
      discountPercent: 20,
    });
    expect(promotion.status).toBe(403);
    expect(createCampaign).toHaveBeenCalledOnce();
    query.mockResolvedValueOnce([{ kind: 'stripe_discount' }]);
    expect(
      (await call('POST', `admin/campaigns/${ID}/revoke`, { reason: 'Expired' }))
        .status,
    ).toBe(403);
    for (const [method, path] of [
      ['POST', 'admin/billing/events/stripe/evt_1/replay'],
      ['POST', 'admin/rewards/process'],
      ['POST', `admin/members/${ID}/role`],
      ['GET', 'admin/members'],
    ] as const) {
      const response = await call(method, path, method === 'GET' ? undefined : input);
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'role_forbidden' },
      });
    }
  });
});
