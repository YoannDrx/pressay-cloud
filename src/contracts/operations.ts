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
  search: z.string().max(120).default(''),
  plan: z.enum(['', 'free', 'pro']).default(''),
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
export const adminUsersSchema = z.object({
  users: z.array(
    z.object({
      id: z.uuid(),
      email: z.email().nullable(),
      display_name: z.string().nullable(),
      status: z.enum(['active', 'deleting', 'deleted']),
      created_at: z.coerce.date().transform((d) => d.toISOString()),
      plan: z.enum(['free', 'pro']),
      active_device_count: z.number().int().nonnegative(),
      last_device_seen_at: z.coerce
        .date()
        .transform((d) => d.toISOString())
        .nullable(),
    }),
  ),
  nextCursor: z.uuid().nullable(),
});
