import { z } from 'zod';

export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const campaignSchema = reasonSchema
  .extend({
    idempotencyKey: z.uuid(),
    kind: z.enum(['access_grant', 'stripe_discount']),
    delivery: z.enum(['code', 'link']).default('code'),
    durationDays: z.coerce.number().int().min(1).max(365).default(30),
    maxRedemptions: z.coerce.number().int().min(1).max(10000).default(1),
    restrictedEmail: z
      .email()
      .transform((v) => v.toLowerCase())
      .optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    discountPercent: z.coerce.number().int().min(1).max(100).optional(),
    discountAmount: z.coerce.number().int().min(1).max(100000).optional(),
  })
  .refine(
    (v) =>
      v.kind !== 'stripe_discount' ||
      Number(v.discountPercent !== undefined) +
        Number(v.discountAmount !== undefined) ===
        1,
    'Choose one discount',
  )
  .refine(
    (v) =>
      v.kind !== 'stripe_discount' || (v.delivery === 'code' && !v.restrictedEmail),
    'Stripe promotions are codes without an email restriction',
  );
export type { CampaignInput } from './operations-wire.js';
export const claimSchema = z.object({
  secret: z
    .string()
    .trim()
    .min(16)
    .max(128)
    .transform((v) => v.toUpperCase()),
  delivery: z.enum(['code', 'link']).optional(),
});
export const attributionSchema = z.object({
  code: z.string().regex(/^[A-Z0-9]{6,16}$/),
  issuedAt: z.number().int().positive(),
});
export const gateSchema = reasonSchema
  .extend({
    status: z.enum(['pending', 'passed', 'blocked']),
    evidence: z.string().trim().max(2000),
  })
  .refine((v) => v.status !== 'passed' || v.evidence.length >= 10, 'Evidence required');
/** Support actions carry the form's idempotency key and a mandatory reason. */
export const supportActionSchema = reasonSchema.extend({ idempotencyKey: z.uuid() });
export const supportGrantSchema = supportActionSchema.extend({
  days: z.coerce.number().int().min(1).max(365),
});
export const adminDeletionSchema = supportActionSchema.extend({
  // Forms submit text; the API also accepts a JSON boolean.
  acknowledgeAppleSubscription: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .default(false),
});
export const memberRoleSchema = z.enum(['owner', 'support', 'readonly']);
/** Add an administrator by the verified address of an existing account. */
export const memberAddSchema = supportActionSchema.extend({
  email: z.email().transform((value) => value.toLowerCase()),
  role: memberRoleSchema,
});
export const memberRoleChangeSchema = supportActionSchema.extend({
  role: memberRoleSchema,
});
export const memberChangeResultSchema = z.object({
  accountId: z.uuid(),
  previousRole: memberRoleSchema.nullable(),
  role: memberRoleSchema.nullable(),
  changed: z.boolean(),
  replayed: z.boolean().default(false),
});
export const adminMembersSchema = z.object({
  members: z.array(
    z.object({
      accountId: z.uuid(),
      authUserId: z.string(),
      email: z.string().nullable(),
      role: memberRoleSchema,
      addedBy: z.uuid().nullable(),
      addedByEmail: z.string().nullable(),
      createdAt: z.coerce.date().transform((d) => d.toISOString()),
      updatedAt: z.coerce.date().transform((d) => d.toISOString()),
    }),
  ),
});
const auditCount = z.number().int().min(0).max(100000);
/** Actions performed by the web on its own database, recorded by the Cloud. */
export const externalAuditSchema = supportActionSchema.extend({
  action: z.enum(['user.sessions.revoke']),
  targetAccountId: z.uuid(),
  result: z.enum(['requested', 'succeeded', 'failed']),
  details: z
    .strictObject({
      webSessions: auditCount,
      oauthRefreshTokens: auditCount,
      oauthAccessTokens: auditCount,
      errorCode: z.string().regex(/^[a-z0-9_]{1,64}$/),
    })
    .partial()
    .default({}),
});
const auditDay = z.iso.date();
export const auditQuerySchema = z.object({
  // Exact action or a dotted prefix such as `grant` or `device.restore`.
  action: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9_.]*$/)
    .default(''),
  // Account id (matches the entry's account), or any exact target id.
  target: z.string().trim().max(120).default(''),
  from: auditDay.optional(),
  to: auditDay.optional(),
  reads: z.enum(['include', 'exclude']).default('include'),
  cursor: z.coerce.number().int().positive().optional(),
});
export const financialEventKinds = [
  'invoice_paid',
  'invoice_failed',
  'invoice_voided',
  'refund',
  'dispute',
] as const;
export const financialEventQuerySchema = z.object({
  kind: z.enum(['', ...financialEventKinds]).default(''),
  // Disputes whose latest status still needs an answer or a decision.
  open: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  cursor: z.string().max(200).optional(),
});
export const providerEventQuerySchema = z.object({
  state: z.enum(['', 'received', 'applied', 'ignored', 'failed']).default(''),
  provider: z.enum(['', 'stripe', 'apple']).default(''),
  cursor: z.string().max(300).optional(),
});
export const userQuerySchema = z.object({
  search: z.string().trim().max(120).default(''),
  // Apple Sandbox access (App Review, TestFlight) is never counted as paid Pro.
  plan: z.enum(['', 'free', 'pro', 'sandbox']).default(''),
  status: z.enum(['', 'active', 'deleting', 'deleted']).default(''),
  cursor: z.uuid().optional(),
});

export const referralSummarySchema = z.object({
  link: z.url(),
  signups: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
  rewards: z.array(
    z.object({
      id: z.uuid(),
      side: z.enum(['referrer', 'referee']),
      status: z.enum([
        'pending',
        'processing',
        'applied',
        'failed',
        'cancelled',
        'review',
      ]),
      kind: z.enum(['credit', 'grant', 'apple_ineligible']).nullable(),
      amount_minor: z.number().int().nullable(),
      currency: z.string().nullable(),
      applied_at: z.coerce
        .date()
        .transform((d) => d.toISOString())
        .nullable(),
      last_error_code: z.string().nullable(),
    }),
  ),
});
const date = z.coerce.date().transform((d) => d.toISOString());
const nullableDate = z.coerce
  .date()
  .transform((d) => d.toISOString())
  .nullable();
const integer = z.coerce.number().int();
export const adminUserSearchKinds = [
  'none',
  'text',
  'uuid',
  'stripe_customer',
  'stripe_subscription',
  'apple_transaction',
] as const;
export type AdminUserSearchKind = (typeof adminUserSearchKinds)[number];
const entitlementSources = z.enum(['none', 'trial', 'stripe', 'app_store', 'support']);
export const adminUsersSchema = z.object({
  users: z.array(
    z.object({
      id: z.uuid(),
      email: z.email().nullable(),
      display_name: z.string().nullable(),
      status: z.enum(['active', 'deleting', 'deleted']),
      created_at: date,
      plan: z.enum(['free', 'pro', 'sandbox']),
      entitlement_source: entitlementSources,
      sandbox: z.boolean(),
      active_device_count: integer.nonnegative(),
      macos_device_count: integer.nonnegative(),
      windows_device_count: integer.nonnegative(),
      last_device_seen_at: nullableDate,
    }),
  ),
  nextCursor: z.uuid().nullable(),
  searchKind: z.enum(adminUserSearchKinds),
});
const auditEntrySchema = z.object({
  id: z.string(),
  actor_id: z.uuid().nullable(),
  action: z.string(),
  target_id: z.string(),
  target_account_id: z.uuid().nullable(),
  reason: z.string(),
  result: z.string(),
  request_id: z.string(),
  details: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .nullable(),
  created_at: date,
});
export const adminAuditLogSchema = z.object({
  entries: z.array(auditEntrySchema.extend({ actor_email: z.string().nullable() })),
  nextCursor: z.string().nullable(),
});
export const supportGrantResultSchema = z.object({
  grantId: z.uuid(),
  accountId: z.uuid(),
  days: integer,
  endsAt: date,
  replayed: z.boolean().default(false),
});
export const deviceActionResultSchema = z.object({
  deviceId: z.uuid(),
  accountId: z.uuid(),
  platform: z.enum(['macos', 'windows']),
  changed: z.boolean(),
  replayed: z.boolean().default(false),
});
export const adminFinancialEventsSchema = z.object({
  events: z.array(
    z.object({
      provider_event_id: z.string(),
      provider_object_id: z.string(),
      provider_subscription_id: z.string().nullable(),
      kind: z.enum(financialEventKinds),
      status: z.string(),
      amount_minor: integer,
      currency: z.string(),
      full_reversal: z.boolean(),
      provider_occurred_at: date,
      account_id: z.uuid().nullable(),
      email: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const adminProviderEventsSchema = z.object({
  events: z.array(
    z.object({
      provider: z.enum(['stripe', 'apple']),
      provider_event_id: z.string(),
      event_type: z.string(),
      state: z.enum(['received', 'applied', 'ignored', 'failed']),
      error_code: z.string().nullable(),
      received_at: date,
      processed_at: nullableDate,
      account_id: z.uuid().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export const adminAlertsSchema = z.object({
  failed_webhooks: integer,
  failed_webhooks_24h: integer,
  open_disputes: integer,
  unpaid_subscriptions: integer,
  duplicate_subscriptions: integer,
  refunds_24h: integer,
  failed_payments_24h: integer,
  checkedAt: z.string(),
});
export const adminMetricsSchema = z.object({
  subscribers: z.array(
    z.object({
      provider: z.enum(['stripe', 'app_store']),
      billing_interval: z.enum(['month', 'year']),
      status: z.enum(['trialing', 'active', 'past_due', 'grace']),
      environment: z.enum(['Production', 'Sandbox']),
      count: integer,
    }),
  ),
  mrr: z.array(
    z.object({
      provider: z.enum(['stripe', 'app_store']),
      currency: z.string(),
      mrr_minor: integer,
      arr_minor: integer,
      subscriptions: integer,
      estimated_subscriptions: integer,
    }),
  ),
  signups: z.array(z.object({ day: z.iso.date(), count: integer })),
  activeAccounts: z.object({ active_7d: integer, active_30d: integer }),
  grants: z.array(z.object({ source: z.string(), count: integer })),
  collectedThisMonth: z.array(
    z.object({
      currency: z.string(),
      paid_minor: integer,
      refunded_minor: integer,
      invoices: integer,
    }),
  ),
  downloads: z.array(
    z.object({
      platform: z.enum(['macos', 'windows']),
      app_version: z.string(),
      last_7d: integer,
      last_30d: integer,
    }),
  ),
  generatedAt: z.string(),
});
export const adminUserDetailSchema = z.object({
  account: z.object({
    accountId: z.uuid(),
    authUserId: z.string(),
    email: z.string().nullable(),
    status: z.enum(['active', 'deleting', 'deleted']),
    createdAt: date,
    deletionRequestedAt: nullableDate,
    entitlement: z.object({
      tier: z.enum(['free', 'pro']),
      source: entitlementSources,
      validFrom: z.string(),
      validUntil: z.string().nullable(),
      offlineGraceUntil: z.string().nullable(),
      revision: integer,
      sandbox: z.boolean(),
    }),
  }),
  billingCustomer: z.object({
    stripeCustomerId: z.string().nullable(),
    appStoreOriginalTransactionId: z.string().nullable(),
    stripeMode: z.enum(['live', 'test']),
  }),
  usage: z.object({
    transcription: z.object({ usedSeconds: integer }),
    transformations: z.object({ used: integer }),
  }),
  usageHistory: z.array(
    z.object({
      period_start: z.string(),
      transcription_seconds_used: integer,
      transformations_used: integer,
    }),
  ),
  devices: z.array(
    z.object({
      id: z.uuid(),
      displayName: z.string(),
      platform: z.enum(['macos', 'windows']),
      appVariant: z.enum(['direct', 'mas']),
      appVersion: z.string(),
      approved: z.boolean(),
      lastSeenAt: date,
      createdAt: date,
      revokedAt: nullableDate,
    }),
  ),
  subscriptions: z.array(
    z.object({
      provider: z.enum(['stripe', 'app_store']),
      provider_subscription_id: z.string(),
      provider_product_id: z.string(),
      status: z.string(),
      billing_interval: z.enum(['month', 'year']),
      trial_ends_at: nullableDate,
      current_period_starts_at: nullableDate,
      current_period_ends_at: nullableDate,
      cancel_at_period_end: z.boolean(),
      grace_ends_at: nullableDate,
      apple_environment: z.enum(['Production', 'Sandbox']),
      created_at: date,
      updated_at: date,
    }),
  ),
  financialEvents: z.array(
    z.object({
      provider_event_id: z.string(),
      provider_object_id: z.string(),
      provider_subscription_id: z.string().nullable(),
      kind: z.enum([
        'invoice_paid',
        'invoice_failed',
        'invoice_voided',
        'refund',
        'dispute',
      ]),
      status: z.string(),
      amount_minor: integer,
      currency: z.string(),
      full_reversal: z.boolean(),
      provider_occurred_at: date,
    }),
  ),
  legalAcceptances: z.array(
    z.object({
      terms_version: z.string(),
      immediate_performance_consent: z.boolean(),
      accepted_at: date,
    }),
  ),
  deletion: z
    .object({
      state: z.enum(['queued', 'processing', 'completed', 'failed']),
      attempts: integer,
      next_attempt_at: date,
      last_error_code: z.string().nullable(),
      created_at: date,
      completed_at: nullableDate,
    })
    .nullable(),
  grants: z.array(
    z.object({
      id: z.uuid(),
      source: z.string(),
      starts_at: date,
      ends_at: date,
      revoked_at: nullableDate,
      reason: z.string().nullable(),
      created_by: z.uuid().nullable(),
    }),
  ),
  referrals: z.array(
    z.object({
      id: z.uuid(),
      referrer_id: z.uuid(),
      referee_id: z.uuid(),
      status: z.string(),
      attributed_at: date,
    }),
  ),
  audit: z.array(auditEntrySchema),
  auditReads: z.object({ count: integer, lastAt: nullableDate }),
  providerEvents: adminProviderEventsSchema.shape.events,
});
/** Months of history for churn, cohorts and trials (current month included). */
const metricMonths = z.coerce.number().int().min(1).max(24).default(12);
/** Days of history for daily aggregates (downloads, sign-ups). */
const metricDays = z.coerce.number().int().min(1).max(366).default(30);
export const advancedMetricsQuerySchema = z.strictObject({
  months: metricMonths,
  days: metricDays,
});
export const metricExportDatasets = [
  'churn',
  'cohorts',
  'trials',
  'downloads',
  'signups',
] as const;
/** Strict per-dataset query: an unknown or misplaced parameter is refused. */
export const metricExportQuerySchemas = {
  churn: z.strictObject({ months: metricMonths }),
  cohorts: z.strictObject({ months: metricMonths }),
  trials: z.strictObject({ months: metricMonths }),
  downloads: z.strictObject({ days: metricDays }),
  signups: z.strictObject({ days: metricDays }),
} as const;
const monthKey = z.string().regex(/^\d{4}-\d{2}$/);
const count = z.coerce.number().int().nonnegative();
export const adminAdvancedMetricsSchema = z.object({
  months: count,
  days: count,
  historyStartedAt: z.coerce
    .date()
    .transform((d) => d.toISOString())
    .nullable(),
  churn: z.array(
    z.object({
      month: monthKey,
      paying_start: count,
      new_paying: count,
      churned: count,
    }),
  ),
  cohorts: z.array(
    z.object({
      month: monthKey,
      signups: count,
      converted: count,
      converted_30d: count,
      trials: count,
    }),
  ),
  trials: z.array(
    z.object({
      month: monthKey,
      started: count,
      converted: count,
      ended: count,
      running: count,
    }),
  ),
  downloads: z.object({
    platforms: z.array(z.object({ platform: z.string(), count })),
    versions: z.array(
      z.object({ platform: z.string(), app_version: z.string(), count }),
    ),
    sources: z.array(z.object({ source: z.string(), count })),
    campaigns: z.array(z.object({ campaign: z.string(), count })),
  }),
  generatedAt: z.string(),
});
