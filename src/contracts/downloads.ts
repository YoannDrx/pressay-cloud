import { z } from 'zod';

const label = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.-]+$/);

/** Download start reported by the public site, never by a browser. */
export const downloadEventSchema = z
  .strictObject({
    anonymousID: z.uuid(),
    platform: z.enum(['macos', 'windows']).default('macos'),
    assetType: z.enum(['dmg', 'exe', 'msi']),
    appVersion: z
      .string()
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    source: label,
    campaign: label.optional(),
    referralCode: label.optional(),
  })
  .refine((event) => (event.platform === 'macos') === (event.assetType === 'dmg'), {
    message: 'The asset does not match the platform',
  });

export type DownloadEvent = z.infer<typeof downloadEventSchema>;
