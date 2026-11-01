import { z } from 'zod';

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

/** Platforms that share the account's three Cloud device slots. */
export const devicePlatformSchema = z.enum(['macos', 'windows', 'ios']);

/**
 * How the app was distributed: `direct` (site download), `mas` (Mac App Store)
 * or `app_store_ios` (App Store and TestFlight on iPhone).
 */
export const deviceAppVariantSchema = z.enum(['direct', 'mas', 'app_store_ios']);

export const bootstrapAccountRequestSchema = z
  .strictObject({
    deviceIdentifier: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    displayName: z.string().trim().min(1).max(120),
    appVariant: deviceAppVariantSchema,
    appVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9A-Za-z.+-]+$/),
    // Older macOS clients omit the field, so it defaults to macOS.
    platform: devicePlatformSchema.default('macos'),
  })
  .refine(
    (device) => (device.platform === 'ios') === (device.appVariant === 'app_store_ios'),
    { message: 'The distribution variant does not match the platform' },
  );

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
  platform: devicePlatformSchema,
  appVariant: deviceAppVariantSchema,
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

export const bootstrapWebAccountResponseSchema = z.strictObject({
  accountId: uuid,
  created: z.boolean(),
  entitlement: entitlementSchema,
});

export const meResponseSchema = z.strictObject({
  accountId: uuid,
  email: z.email(),
  status: z.enum(['active', 'deleting', 'deleted']),
  createdAt: isoDateTime,
  entitlement: entitlementSchema,
});

export const revokedDeviceSchema = deviceSchema.extend({ revokedAt: isoDateTime });

export const deviceListResponseSchema = z.strictObject({
  devices: z.array(deviceSchema),
  limit: z.literal(3),
  // Only with `?include=revoked`: revoked devices the owner can restore.
  revokedDevices: z.array(revokedDeviceSchema).optional(),
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
export type RevokedDevice = z.infer<typeof revokedDeviceSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
