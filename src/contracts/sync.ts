import { z } from 'zod';

const boundedBase64 = (maximumBytes: number) =>
  z
    .string()
    .min(4)
    .max(Math.ceil((maximumBytes * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const enrollSyncDeviceRequestSchema = z.strictObject({
  deviceId: z.uuid(),
  publicKey: boundedBase64(512),
  encryptedAccountKey: boundedBase64(16_384).optional(),
});

export const approveSyncDeviceRequestSchema = z.strictObject({
  approverDeviceId: z.uuid(),
  encryptedAccountKey: boundedBase64(16_384),
});

export const configureSyncRecoveryRequestSchema = z.strictObject({
  deviceId: z.uuid(),
  codeHash: boundedBase64(32),
  encryptedAccountKey: boundedBase64(16_384),
});

export const beginSyncRecoveryRequestSchema = z.strictObject({
  deviceId: z.uuid(),
  publicKey: boundedBase64(512),
  codeHash: boundedBase64(32),
});

export const completeSyncRecoveryRequestSchema = z.strictObject({
  deviceId: z.uuid(),
  codeHash: boundedBase64(32),
  encryptedAccountKey: boundedBase64(16_384),
});

export const syncRecoveryEnvelopeResponseSchema = z.strictObject({
  encryptedAccountKey: boundedBase64(16_384),
});

export const syncChangeInputSchema = z.strictObject({
  objectType: z.enum(['mode', 'profile', 'dictionary', 'preference']),
  objectId: z.uuid(),
  revision: z.int().positive(),
  envelope: boundedBase64(1_048_576),
  envelopeVersion: z.int().positive().max(32).default(1),
  tombstone: z.boolean().default(false),
});

export const appendSyncChangesRequestSchema = z.strictObject({
  deviceId: z.uuid(),
  changes: z.array(syncChangeInputSchema).min(1).max(100),
});

export const syncChangeOutputSchema = syncChangeInputSchema.extend({
  sequenceId: z.int().positive(),
  sourceDeviceId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  conflict: z.boolean(),
});

export const syncChangesResponseSchema = z.strictObject({
  changes: z.array(syncChangeOutputSchema),
  nextCursor: z.int().nonnegative(),
  hasMore: z.boolean(),
});

export type SyncChangeInput = z.infer<typeof syncChangeInputSchema>;
