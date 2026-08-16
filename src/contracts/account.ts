import { z } from 'zod';

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const bootstrapAccountRequestSchema = z.strictObject({
  deviceIdentifier: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  displayName: z.string().trim().min(1).max(120),
  appVariant: z.enum(['direct', 'mas']),
  appVersion: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[0-9A-Za-z.+-]+$/),
});

export const entitlementSchema = z.strictObject({
  tier: z.enum(['free', 'pro']),
  source: z.enum(['none', 'trial', 'stripe', 'app_store', 'support']),
  validFrom: isoDateTime,
  validUntil: isoDateTime.nullable(),
  offlineGraceUntil: isoDateTime.nullable(),
  revision: z.int().positive(),
});

export const deviceSchema = z.strictObject({
  id: uuid,
  displayName: z.string(),
  appVariant: z.enum(['direct', 'mas']),
  appVersion: z.string(),
  approved: z.boolean(),
  lastSeenAt: isoDateTime,
  createdAt: isoDateTime,
});

export const bootstrapAccountResponseSchema = z.strictObject({
  accountId: uuid,
  created: z.boolean(),
  device: deviceSchema.pick({ id: true }),
  entitlement: entitlementSchema,
});

export const meResponseSchema = z.strictObject({
  accountId: uuid,
  email: z.email(),
  status: z.enum(['active', 'deleting', 'deleted']),
  createdAt: isoDateTime,
  entitlement: entitlementSchema,
});

export const deviceListResponseSchema = z.strictObject({
  devices: z.array(deviceSchema),
  limit: z.literal(3),
});

export const usageSnapshotSchema = z.strictObject({
  periodStart: z.iso.date(),
  transcription: z.strictObject({
    usedSeconds: z.int().nonnegative(),
    reservedSeconds: z.int().nonnegative(),
    limitSeconds: z.int().nonnegative(),
  }),
  transformations: z.strictObject({
    used: z.int().nonnegative(),
    reserved: z.int().nonnegative(),
    limit: z.int().nonnegative(),
  }),
});

export const signedEntitlementSnapshotSchema = z.strictObject({
  token: z.string().min(64),
  keyId: z.string(),
  expiresAt: isoDateTime,
});

export const entitlementResponseSchema = z.strictObject({
  entitlement: entitlementSchema,
  usage: usageSnapshotSchema,
  signedSnapshot: signedEntitlementSnapshotSchema,
});

export type BootstrapAccountRequest = z.infer<typeof bootstrapAccountRequestSchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
