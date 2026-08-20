import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('pressay-cloud'),
  version: z.string(),
  environment: z.string(),
});

export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'unavailable']),
  checks: z.object({
    database: z.enum(['up', 'down']),
    schemaVersion: z.string().nullable(),
  }),
});
