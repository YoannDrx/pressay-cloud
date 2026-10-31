import { z } from 'zod';

export const waitlistPlatforms = ['ios', 'windows'] as const;
export type WaitlistPlatform = (typeof waitlistPlatforms)[number];

/** Sign-up from the public site; consent must be given explicitly. */
export const waitlistSignupSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  platform: z.enum(waitlistPlatforms),
  locale: z.enum(['fr', 'en']),
  source: z
    .string()
    .regex(/^[a-z0-9_-]{1,40}$/)
    .default('site'),
  consent: z.literal(true),
});
export type WaitlistSignup = z.infer<typeof waitlistSignupSchema>;

const count = z.coerce.number().int().nonnegative();
export const adminWaitlistSchema = z.object({
  platforms: z.array(
    z.object({
      platform: z.enum(waitlistPlatforms),
      subscribed: count,
      unsubscribed: count,
      french: count,
      english: count,
      last_7d: count,
      last_signup_at: z.coerce
        .date()
        .transform((date) => date.toISOString())
        .nullable(),
    }),
  ),
  sources: z.array(
    z.object({ platform: z.enum(waitlistPlatforms), source: z.string(), count }),
  ),
});
export type AdminWaitlist = z.infer<typeof adminWaitlistSchema>;

export const waitlistExportQuerySchema = z.object({
  platform: z.enum(waitlistPlatforms),
});
