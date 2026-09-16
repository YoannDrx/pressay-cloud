import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import type { AppEnvironment } from '../types.js';
import { requireAuthentication } from '../lib/auth-middleware.js';
import { ApiError } from '../lib/errors.js';
import { getSql } from '../db/client.js';
import { getEnvironment } from '../env.js';
import { getStripe } from '../billing/stripe-client.js';
import {
  bootstrapWebAccount,
  recordAccountContact,
  getUsage,
  listDevices,
  getAccountSnapshot,
} from '../services/accounts.js';
import {
  accountId,
  audit,
  ownerAccount,
  createCampaign,
  revokeCampaign,
  claimAccess,
} from '../services/operations.js';
import {
  attributeReferral,
  myReferrals,
  runReferralRewards,
  requireReferrals,
} from '../services/referrals.js';
import { consume } from '../services/rate-limits.js';
import {
  campaignSchema,
  adminUsersSchema,
  claimSchema,
  attributionSchema,
  reasonSchema,
  gateSchema,
  userQuerySchema,
} from '../contracts/operations.js';

export const operationsRoutes = new Hono<AppEnvironment>();
operationsRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});
operationsRoutes.use('/admin/*', requireAuthentication);
operationsRoutes.use('/referrals/*', requireAuthentication);
operationsRoutes.use('/access/*', requireAuthentication);
operationsRoutes.use('/admin/*', async (c, next) => {
  if (!c.get('authEmailVerified'))
    throw new ApiError(403, 'verified_email_required', 'Verify your email');
  await bootstrapWebAccount(c.get('authUserId'));
  await recordAccountContact(c.get('authUserId'), c.get('authEmail'));
  const owner = await ownerAccount(c.get('authUserId'), c.get('authEmail'), true);
  if (!owner)
    throw new ApiError(403, 'admin_required', 'Administrator access required');
  c.set('operationsAccountId', owner);
  if (c.req.method !== 'GET') {
    const at = c.get('authStepUpAt');
    const now = Math.floor(Date.now() / 1000);
    if (
      !c.get('authSessionId') ||
      !Number.isFinite(at) ||
      at <= now - 600 ||
      at > now + 30
    )
      throw new ApiError(
        403,
        'step_up_required',
        'Verify your second factor within ten minutes',
      );
    await consume('admin_mutation', owner, 20);
  }
  await next();
});
operationsRoutes.use('/referrals/*', verifiedAccount);
operationsRoutes.use('/access/*', verifiedAccount);
async function verifiedAccount(c: Context<AppEnvironment>, next: Next) {
  if (!c.get('authEmailVerified'))
    throw new ApiError(403, 'verified_email_required', 'Verify your email');
  await bootstrapWebAccount(c.get('authUserId'));
  await recordAccountContact(c.get('authUserId'), c.get('authEmail'));
  c.set('operationsAccountId', await accountId(c.get('authUserId')));
  await next();
}
async function body<T>(c: Context<AppEnvironment>, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (!result.success)
    throw new ApiError(422, 'invalid_request', 'Check the submitted fields');
  return result.data;
}
function uuid(value: string) {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw new ApiError(422, 'invalid_id', 'Invalid identifier');
  return result.data;
}
operationsRoutes.get('/referral-codes/:code', async (c) => {
  requireReferrals();
  const code = c.req.param('code');
  if (!/^[A-Z0-9]{6,16}$/.test(code)) return c.json({ valid: false });
  const rows = await getSql().query(
    "SELECT 1 FROM referral_code r JOIN pressay_account a ON a.id=r.account_id WHERE r.code=$1 AND a.status='active'",
    [code],
  );
  return c.json({ valid: rows.length > 0 });
});
operationsRoutes.get('/admin/session', (c) => c.json({ role: 'owner' }));
operationsRoutes.get('/admin/overview', async (c) => {
  const rows = await getSql().query(
    `SELECT
    (SELECT count(*)::int FROM pressay_account WHERE status='active') AS users,
    (SELECT count(*)::int FROM pressay_account WHERE created_at>now()-interval '30 days') AS new_30d,
    (SELECT count(*)::int FROM access_grant WHERE revoked_at IS NULL AND ends_at>now()) AS active_grants,
    (SELECT count(*)::int FROM referral_attribution) AS referrals,
    (SELECT count(*)::int FROM referral_attribution WHERE status='converted') AS conversions,
    (SELECT COALESCE(sum(amount_minor),0)::int FROM referral_reward WHERE kind='credit' AND status='applied') AS credits_minor,
    (SELECT count(*)::int FROM provider_event WHERE state='failed') AS failed_webhooks,
    (SELECT COALESCE(sum(transcription_seconds_used),0)::int FROM usage_period WHERE period_start=date_trunc('month',now())::date) AS cloud_seconds,
    (SELECT COALESCE(sum(transformations_used),0)::int FROM usage_period WHERE period_start=date_trunc('month',now())::date) AS cloud_transformations`,
    [],
  );
  const plans = await getSql().query(
    "SELECT CASE WHEN tier='pro' AND valid_until>now() THEN 'pro' ELSE 'free' END AS plan,count(*)::int AS count FROM entitlement GROUP BY 1",
    [],
  );
  const subscriptions = await getSql().query(
    "SELECT provider,billing_interval,count(*)::int AS count FROM billing_subscription WHERE apple_environment='Production' AND status IN ('active','past_due','grace') AND current_period_ends_at>now() GROUP BY 1,2",
    [],
  );
  const env = getEnvironment();
  const catalogueMRRMinor = subscriptions
    .filter((s) => s.provider === 'stripe')
    .reduce(
      (sum, s) =>
        sum +
        Number(s.count) *
          (s.billing_interval === 'year'
            ? env.PRESSAY_PRO_ANNUAL_AMOUNT_MINOR / 12
            : env.PRESSAY_PRO_MONTHLY_AMOUNT_MINOR),
      0,
    );
  return c.json({
    ...rows[0],
    plans,
    subscriptions,
    catalogueMRRMinor: Math.round(catalogueMRRMinor),
  });
});
operationsRoutes.get('/admin/users', async (c) => {
  const parsed = userQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(422, 'invalid_query', 'Invalid filter');
  const q = parsed.data;
  const rows = await getSql().query(
    `SELECT a.id,u.email,u.email AS display_name,a.status,a.created_at,
    CASE WHEN e.tier='pro' AND e.valid_until>now() THEN 'pro' ELSE 'free' END AS plan,
    (SELECT count(*)::int FROM pressay_device WHERE account_id=a.id AND revoked_at IS NULL) AS active_device_count,
    (SELECT max(last_seen_at) FROM pressay_device WHERE account_id=a.id) AS last_device_seen_at
    FROM pressay_account a LEFT JOIN account_contact u ON u.account_id=a.id JOIN entitlement e ON e.account_id=a.id
    WHERE ($1='' OR u.email ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%' OR a.id::text=$1)
      AND ($2='' OR (CASE WHEN e.tier='pro' AND e.valid_until>now() THEN 'pro' ELSE 'free' END)=$2)
      AND ($3='' OR a.status=$3) AND ($4::uuid IS NULL OR a.id>$4::uuid)
    ORDER BY a.id LIMIT 51`,
    [q.search, q.plan, q.status, q.cursor ?? null],
  );
  return c.json(
    adminUsersSchema.parse({
      users: rows.slice(0, 50),
      nextCursor: rows.length > 50 ? String(rows[49]?.id) : null,
    }),
  );
});
operationsRoutes.get('/admin/users/:id', async (c) => {
  const id = uuid(c.req.param('id'));
  const rows = await getSql().query(
    'SELECT a.auth_user_id,u.email FROM pressay_account a LEFT JOIN account_contact u ON u.account_id=a.id WHERE a.id=$1',
    [id],
  );
  if (!rows[0]) throw new ApiError(404, 'account_not_found', 'Account not found');
  const [account, usage, devices, subscriptions, grants, referrals] = await Promise.all(
    [
      getAccountSnapshot(String(rows[0].auth_user_id)),
      getUsage(String(rows[0].auth_user_id)),
      listDevices(String(rows[0].auth_user_id)),
      getSql().query(
        'SELECT provider,status,billing_interval,current_period_ends_at,apple_environment FROM billing_subscription WHERE account_id=$1',
        [id],
      ),
      getSql().query(
        'SELECT id,source,starts_at,ends_at,revoked_at FROM access_grant WHERE account_id=$1 ORDER BY created_at DESC',
        [id],
      ),
      getSql().query(
        'SELECT id,referrer_id,referee_id,status,attributed_at FROM referral_attribution WHERE referrer_id=$1 OR referee_id=$1',
        [id],
      ),
    ],
  );
  return c.json({
    account: { ...account, email: rows[0].email ? String(rows[0].email) : null },
    usage,
    devices,
    subscriptions,
    grants,
    referrals,
  });
});
operationsRoutes.get('/admin/campaigns', async (c) =>
  c.json({
    campaigns: await getSql().query(
      'SELECT id,kind,delivery,code_hint,duration_days,discount_percent,discount_amount,max_redemptions,redemptions,status,expires_at,stripe_promotion_id FROM access_campaign ORDER BY created_at DESC LIMIT 100',
      [],
    ),
  }),
);
operationsRoutes.post('/admin/campaigns', async (c) =>
  c.json(
    await createCampaign(
      c.get('operationsAccountId'),
      await body(c, campaignSchema),
      c.get('requestId'),
    ),
    201,
  ),
);
operationsRoutes.get('/admin/campaigns/:id/usage', async (c) => {
  const rows = await getSql().query(
    "SELECT stripe_promotion_id FROM access_campaign WHERE id=$1 AND kind='stripe_discount'",
    [uuid(c.req.param('id'))],
  );
  if (!rows[0]?.stripe_promotion_id)
    throw new ApiError(404, 'promotion_unavailable', 'Promotion unavailable');
  const promotion = await getStripe().promotionCodes.retrieve(
    String(rows[0].stripe_promotion_id),
    {},
    { timeout: 5000, maxNetworkRetries: 0 },
  );
  return c.json({
    redemptions: promotion.times_redeemed,
    maximum: promotion.max_redemptions,
    active: promotion.active,
    checkedAt: new Date().toISOString(),
  });
});
operationsRoutes.post('/admin/campaigns/:id/revoke', async (c) => {
  const input = await body(c, reasonSchema);
  await revokeCampaign(
    uuid(c.req.param('id')),
    c.get('operationsAccountId'),
    input.reason,
    c.get('requestId'),
  );
  return c.json({ revoked: true });
});
operationsRoutes.post('/admin/grants/:id/revoke', async (c) => {
  const input = await body(c, reasonSchema);
  const id = uuid(c.req.param('id'));
  await audit(
    c.get('operationsAccountId'),
    'grant.revoke.requested',
    id,
    input.reason,
    c.get('requestId'),
    'requested',
  );
  const rows = await getSql().query('SELECT revoke_pressay_grant($1) AS revoked', [id]);
  if (!rows[0]?.revoked) throw new ApiError(404, 'grant_not_found', 'Grant not found');
  await audit(
    c.get('operationsAccountId'),
    'grant.revoked',
    id,
    input.reason,
    c.get('requestId'),
  );
  return c.json({ revoked: true });
});
operationsRoutes.get('/admin/referrals', async (c) =>
  c.json({
    referrals: await getSql().query(
      `SELECT a.*,u.email AS referrer_email,v.email AS referee_email,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'side',r.side,'status',r.status,'kind',r.kind,'amount_minor',r.amount_minor,'last_error_code',r.last_error_code)) FROM referral_reward r WHERE r.attribution_id=a.id),'[]') AS rewards
  FROM referral_attribution a JOIN pressay_account p ON p.id=a.referrer_id LEFT JOIN account_contact u ON u.account_id=p.id
  JOIN pressay_account q ON q.id=a.referee_id LEFT JOIN account_contact v ON v.account_id=q.id ORDER BY a.attributed_at DESC LIMIT 100`,
      [],
    ),
  }),
);
operationsRoutes.post('/admin/rewards/process', async (c) => {
  const input = await body(c, reasonSchema);
  await audit(
    c.get('operationsAccountId'),
    'rewards.process',
    'queue',
    input.reason,
    c.get('requestId'),
    'requested',
  );
  const result = await runReferralRewards(10);
  await audit(
    c.get('operationsAccountId'),
    'rewards.process',
    'queue',
    input.reason,
    c.get('requestId'),
  );
  return c.json(result);
});
operationsRoutes.post('/admin/rewards/:id/retry', async (c) => {
  const input = await body(c, reasonSchema);
  const id = uuid(c.req.param('id'));
  await audit(
    c.get('operationsAccountId'),
    'reward.retry',
    id,
    input.reason,
    c.get('requestId'),
    'requested',
  );
  const rows = await getSql().query(
    "UPDATE referral_reward SET status='pending',attempts=0,next_attempt_at=now(),locked_until=NULL WHERE id=$1 AND status='failed' AND first_attempt_at>now()-interval '23 hours' RETURNING id",
    [id],
  );
  if (!rows.length)
    throw new ApiError(
      409,
      'reconciliation_required',
      'Inspect provider ledger before retrying',
    );
  return c.json(await runReferralRewards(10));
});
operationsRoutes.get('/admin/billing/events', async (c) =>
  c.json({
    events: await getSql().query(
      'SELECT provider,provider_event_id,event_type,state,error_code,received_at,processed_at FROM provider_event ORDER BY received_at DESC LIMIT 100',
      [],
    ),
  }),
);
operationsRoutes.get('/admin/audit-log', async (c) =>
  c.json({
    entries: await getSql().query(
      'SELECT * FROM operations_audit ORDER BY id DESC LIMIT 100',
      [],
    ),
  }),
);
operationsRoutes.get('/admin/health', async (c) => {
  const gates = await getSql().query(
    'SELECT * FROM launch_gate ORDER BY channel,id',
    [],
  );
  const jobs = await getSql().query(
    'SELECT status,count(*)::int AS count FROM referral_reward GROUP BY status',
    [],
  );
  const env = getEnvironment();
  return c.json({
    gates,
    jobs,
    flags: {
      directCheckout: env.STRIPE_COMMERCIAL_LAUNCH_ENABLED,
      cloud: env.PRESSAY_CLOUD_PROCESSING_ENABLED,
      referrals: env.PRESSAY_REFERRALS_ENABLED,
    },
    checkedAt: new Date().toISOString(),
  });
});
operationsRoutes.patch('/admin/gates/:channel/:id', async (c) => {
  const input = await body(c, gateSchema);
  const channel = c.req.param('channel');
  const id = c.req.param('id');
  await audit(
    c.get('operationsAccountId'),
    'launch_gate.updated',
    `${channel}/${id}`,
    input.reason,
    c.get('requestId'),
    'requested',
  );
  const rows = await getSql().query(
    'UPDATE launch_gate SET status=$3,evidence=$4,checked_at=now() WHERE channel=$1 AND id=$2 RETURNING id',
    [channel, id, input.status, input.evidence],
  );
  if (!rows.length) throw new ApiError(404, 'gate_not_found', 'Gate not found');
  await audit(
    c.get('operationsAccountId'),
    'launch_gate.updated',
    `${channel}/${id}`,
    input.reason,
    c.get('requestId'),
  );
  return c.json({ updated: true });
});
operationsRoutes.get('/referrals/me', async (c) =>
  c.json(await myReferrals(c.get('operationsAccountId'))),
);
operationsRoutes.post('/referrals/attribute', async (c) => {
  if (!c.get('authWebProxy'))
    throw new ApiError(403, 'signed_referral_required', 'Use the signed referral link');
  await consume('referral_attribute', c.get('authUserId'), 10);
  const input = await body(c, attributionSchema);
  return c.json(
    await attributeReferral(c.get('operationsAccountId'), input.code, input.issuedAt),
  );
});
operationsRoutes.post('/access/claim', async (c) => {
  await consume('access_claim', c.get('authUserId'), 10);
  const input = await body(c, claimSchema);
  return c.json(
    await claimAccess(c.get('operationsAccountId'), c.get('authEmail'), input.secret),
  );
});
