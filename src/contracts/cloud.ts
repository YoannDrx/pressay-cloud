import { z } from 'zod';

const languageCode = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
  .optional();

export const cloudTransformationRequestSchema = z.strictObject({
  deviceId: z.uuid(),
  transcript: z.string().min(1).max(50_000),
  instruction: z.string().min(1).max(8_000),
  selectedText: z.string().max(20_000).optional(),
  applicationName: z.string().trim().min(1).max(200).optional(),
  language: languageCode,
  contentTransferAcknowledged: z.literal(true),
});

export const cloudTransformationResponseSchema = z.strictObject({
  text: z.string(),
  modelAlias: z.literal('pressay-transform-v1'),
  operationId: z.string().min(1),
});

export const cloudTranscriptionResponseSchema = z.strictObject({
  text: z.string(),
  modelAlias: z.literal('pressay-transcribe-v1'),
  operationId: z.string().min(1),
  durationSeconds: z.number().positive(),
});

export type CloudTransformationRequest = z.infer<
  typeof cloudTransformationRequestSchema
>;
