import { z } from 'zod';

export const checkoutRequestSchema = z.strictObject({
  interval: z.enum(['month', 'year']),
});

export const billingRedirectSchema = z.strictObject({
  url: z.url(),
});

export const restoreAppStoreRequestSchema = z.strictObject({
  signedTransaction: z.string().min(64).max(250_000),
});

export const restoreAppStoreResponseSchema = z.strictObject({
  restored: z.boolean(),
});

export const billingStatusSchema = z.strictObject({
  provider: z.enum(['stripe', 'app_store']).nullable(),
  interval: z.enum(['month', 'year']).nullable(),
  status: z
    .enum([
      'trialing',
      'active',
      'past_due',
      'grace',
      'paused',
      'canceled',
      'expired',
      'refunded',
    ])
    .nullable(),
  currentPeriodEndsAt: z.iso.datetime({ offset: true }).nullable(),
  cancelAtPeriodEnd: z.boolean(),
});

export type BillingInterval = z.infer<typeof checkoutRequestSchema>['interval'];
