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
  audit: z.array(
    z.object({
      id: z.string(),
      actor_id: z.uuid().nullable(),
      action: z.string(),
      target_id: z.string(),
      reason: z.string(),
      result: z.string(),
      request_id: z.string(),
      created_at: date,
    }),
  ),
  auditReads: z.object({ count: integer, lastAt: nullableDate }),
});
