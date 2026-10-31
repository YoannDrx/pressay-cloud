import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import type { AppEnvironment } from '../types.js';
import { requireAuthentication } from '../lib/auth-middleware.js';
import { ApiError } from '../lib/errors.js';
import { rateLimit } from '../lib/rate-limit.js';
import { isRecentAuthentication } from '../lib/recent-authentication.js';
import { getSql } from '../db/client.js';
import { expectedStripeLivemode, getEnvironment } from '../env.js';
import { getStripe } from '../billing/stripe-client.js';
import { bootstrapWebAccount, recordAccountContact } from '../services/accounts.js';
import { customerDetail, searchAccounts } from '../services/admin-customers.js';
import { exportAccountDataForSupport } from '../services/data-export.js';
import { adminMetrics } from '../services/admin-metrics.js';
import {
  billingAlerts,
  financialEvents,
  providerEvents,
  replayProviderEvent,
} from '../services/admin-billing.js';
import {
  auditLog,
  extendGrant,
  offerSupportAccess,
  recordExternalAction,
  requestDeletionAsSupport,
  restoreDeviceAsSupport,
  revokeDeviceAsSupport,
  revokeGrant,
  type Operator,
} from '../services/admin-support.js';
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
import { waitlistExportQuerySchema } from '../contracts/waitlist.js';
import { waitlistCsv, waitlistSummary } from '../services/waitlist.js';
import {
  campaignSchema,
  claimSchema,
  attributionSchema,
  reasonSchema,
  gateSchema,
  userQuerySchema,
  adminDeletionSchema,
  auditQuerySchema,
  externalAuditSchema,
  supportActionSchema,
  supportGrantSchema,
  financialEventQuerySchema,
  providerEventQuerySchema,
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
  const mutation = c.req.method !== 'GET';
  if (mutation || personalDataRead(c.req.path))
    requireRecentStepUp(c.get('authSessionId'), c.get('authStepUpAt'));
  if (mutation) await consume('admin_mutation', owner, 20);
  await next();
});
/** Admin reads that return emails, a person's full record or the audit ledger. */
function personalDataRead(path: string): boolean {
  return /\/admin\/(users(\/[^/]+)?|referrals|audit-log|billing\/financial-events)\/?$/.test(
    path,
  );
}
function operator(c: Context<AppEnvironment>): Operator {
  return { actor: c.get('operationsAccountId'), requestId: c.get('requestId') };
}
/** Second-factor proof bound to the web session, less than ten minutes old. */
function requireRecentStepUp(sessionId: string, at: number): void {
  if (!sessionId || !isRecentAuthentication(at))
    throw new ApiError(
      403,
      'step_up_required',
      'Verify your second factor within ten minutes',
    );
}
/** Personal-data reads are recorded like mutations (no search terms stored). */
async function auditRead(
  c: Context<AppEnvironment>,
  action: string,
  target: string,
  targetAccountId: string | null = null,
) {
  await audit(
    c.get('operationsAccountId'),
    action,
    target,
    'personal_data_read',
    c.get('requestId'),
    'succeeded',
    { targetAccountId },
  );
}
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
operationsRoutes.get(
  '/referral-codes/:code',
  rateLimit('referral_code_lookup', 30, 'ip'),
  async (c) => {
    requireReferrals();
    const code = c.req.param('code');
    if (!/^[A-Z0-9]{6,16}$/.test(code)) return c.json({ valid: false });
    const rows = await getSql().query(
      "SELECT 1 FROM referral_code r JOIN pressay_account a ON a.id=r.account_id WHERE r.code=$1 AND a.status='active'",
      [code],
    );
    return c.json({ valid: rows.length > 0 });
  },
);
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
    (SELECT COALESCE(sum(transformations_used),0)::int FROM usage_period WHERE period_start=date_trunc('month',now())::date) AS cloud_transformations,
    (SELECT count(*)::int FROM download_event WHERE created_at>now()-interval '7 days') AS downloads_7d,
    (SELECT count(*)::int FROM download_event WHERE created_at>now()-interval '30 days') AS downloads_30d`,
    [],
  );
  // Apple Sandbox access (App Review, TestFlight) is reported apart from paid Pro.
  const plans = await getSql().query(
    `SELECT CASE WHEN e.tier='pro' AND e.valid_until>now()
      THEN CASE WHEN e.sandbox THEN 'sandbox' ELSE 'pro' END ELSE 'free' END AS plan,
      count(*)::int AS count
    FROM entitlement e JOIN pressay_account a ON a.id=e.account_id
    WHERE a.status='active' GROUP BY 1`,
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
  await auditRead(c, 'admin.users.read', 'users');
  return c.json(await searchAccounts(parsed.data));
});
operationsRoutes.get('/admin/users/:id', async (c) => {
  const id = uuid(c.req.param('id'));
  await auditRead(c, 'admin.user.read', id, id);
  // The web reads linked identities, passkeys and sessions from its own
  // database only after this owner + step-up check succeeds; record that too.
  if (c.req.query('include') === 'identity')
    await auditRead(c, 'admin.user.identity.read', id, id);
  return c.json(
    await customerDetail(
      id,
      expectedStripeLivemode(getEnvironment()) ? 'live' : 'test',
    ),
  );
});
// Access request (GDPR art. 15): the account's data as a JSON file. The web
// adds its own sign-in data with `?include=identity`, which is recorded too.
operationsRoutes.get('/admin/users/:id/export', async (c) => {
  requireRecentStepUp(c.get('authSessionId'), c.get('authStepUpAt'));
  const id = uuid(c.req.param('id'));
  const include = c.req.query('include');
  if (include !== undefined && include !== 'identity')
    throw new ApiError(422, 'invalid_query', 'Invalid filter');
  const data = await exportAccountDataForSupport(id);
  await audit(
    c.get('operationsAccountId'),
    'admin.user.export',
    id,
    'data_export',
    c.get('requestId'),
    'succeeded',
    { targetAccountId: id, details: { siteIdentity: include === 'identity' } },
  );
  c.header('Content-Disposition', `attachment; filename="pressay-account-${id}.json"`);
  return c.json(data);
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
  await revokeGrant(operator(c), uuid(c.req.param('id')), await body(c, reasonSchema));
  return c.json({ revoked: true });
});
operationsRoutes.post('/admin/grants/:id/extend', async (c) =>
  c.json(
    await extendGrant(
      operator(c),
      uuid(c.req.param('id')),
      await body(c, supportGrantSchema),
    ),
  ),
);
operationsRoutes.post('/admin/users/:id/grants', async (c) =>
  c.json(
    await offerSupportAccess(
      operator(c),
      uuid(c.req.param('id')),
      await body(c, supportGrantSchema),
    ),
    201,
  ),
);
operationsRoutes.post('/admin/users/:id/deletion', async (c) =>
  c.json(
    await requestDeletionAsSupport(
      operator(c),
      uuid(c.req.param('id')),
      await body(c, adminDeletionSchema),
    ),
    202,
  ),
);
operationsRoutes.post('/admin/devices/:id/revoke', async (c) =>
  c.json(
    await revokeDeviceAsSupport(
      operator(c),
      uuid(c.req.param('id')),
      await body(c, supportActionSchema),
    ),
  ),
);
operationsRoutes.post('/admin/devices/:id/restore', async (c) =>
  c.json(
    await restoreDeviceAsSupport(
      operator(c),
      uuid(c.req.param('id')),
      await body(c, supportActionSchema),
    ),
  ),
);
// Actions the web performs on its own database (sessions, OAuth tokens),
// after this owner + step-up check. Not relayed by the browser proxy.
operationsRoutes.post('/admin/audit/external', async (c) =>
  c.json(await recordExternalAction(operator(c), await body(c, externalAuditSchema))),
);
operationsRoutes.get('/admin/referrals', async (c) => {
  await auditRead(c, 'admin.referrals.read', 'referrals');
  return c.json({
    referrals: await getSql().query(
      `SELECT a.*,u.email AS referrer_email,v.email AS referee_email,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'side',r.side,'status',r.status,'kind',r.kind,'amount_minor',r.amount_minor,'last_error_code',r.last_error_code)) FROM referral_reward r WHERE r.attribution_id=a.id),'[]') AS rewards
  FROM referral_attribution a JOIN pressay_account p ON p.id=a.referrer_id LEFT JOIN account_contact u ON u.account_id=p.id
  JOIN pressay_account q ON q.id=a.referee_id LEFT JOIN account_contact v ON v.account_id=q.id ORDER BY a.attributed_at DESC LIMIT 100`,
      [],
    ),
  });
});
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
operationsRoutes.get('/admin/billing/events', async (c) => {
  const parsed = providerEventQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(422, 'invalid_query', 'Invalid filter');
  return c.json(await providerEvents(parsed.data));
});
operationsRoutes.get('/admin/billing/financial-events', async (c) => {
  const parsed = financialEventQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(422, 'invalid_query', 'Invalid filter');
  await auditRead(c, 'admin.billing.financial.read', 'billing/financial-events');
  return c.json(await financialEvents(parsed.data));
});
operationsRoutes.post('/admin/billing/events/:provider/:id/replay', async (c) => {
  const eventId = c.req.param('id');
  if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(eventId))
    throw new ApiError(422, 'invalid_id', 'Invalid identifier');
  return c.json(
    await replayProviderEvent(
      operator(c),
      c.req.param('provider'),
      eventId,
      await body(c, supportActionSchema),
    ),
  );
});
operationsRoutes.get('/admin/alerts', async (c) => c.json(await billingAlerts()));
operationsRoutes.get('/admin/metrics', async (c) => c.json(await adminMetrics()));
operationsRoutes.get('/admin/audit-log', async (c) => {
  const parsed = auditQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(422, 'invalid_query', 'Invalid filter');
  await auditRead(c, 'admin.audit.read', 'audit-log');
  return c.json(await auditLog(parsed.data));
});
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
// Waitlist counters carry no address; the export is a personal-data read.
operationsRoutes.get('/admin/waitlist', async (c) => c.json(await waitlistSummary()));
operationsRoutes.get('/admin/waitlist/export', async (c) => {
  requireRecentStepUp(c.get('authSessionId'), c.get('authStepUpAt'));
  const query = waitlistExportQuerySchema.safeParse(c.req.query());
  if (!query.success) throw new ApiError(422, 'invalid_query', 'Choose a platform');
  const { csv, rows } = await waitlistCsv(query.data.platform);
  await auditRead(c, 'admin.waitlist.export', `waitlist/${query.data.platform}`);
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header(
    'Content-Disposition',
    `attachment; filename="pressay-waitlist-${query.data.platform}.csv"`,
  );
  c.header('X-Waitlist-Rows', String(rows));
  return c.body(csv);
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
