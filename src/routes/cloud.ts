import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  cloudTransformationRequestSchema,
  cloudTransformationResponseSchema,
  cloudTranscriptionResponseSchema,
} from '../contracts/cloud.js';
import { requireAuthentication } from '../lib/auth-middleware.js';
import { getClientIp } from '../lib/client-ip.js';
import { ApiError } from '../lib/errors.js';
import { cloudAudioLimits } from '../lib/wav.js';
import {
  processCloudTransformation,
  processCloudTranscription,
} from '../services/cloud-processing.js';
import {
  assertCloudProcessingEnabled,
  enforceCloudRateLimits,
} from '../services/rate-limits.js';
import type { AppEnvironment } from '../types.js';

const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(255)
  .regex(/^[A-Za-z0-9._:-]+$/);
const transcriptionFieldsSchema = z.strictObject({
  deviceId: z.uuid(),
  language: z
    .string()
    .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)
    .optional(),
  contentTransferAcknowledged: z.literal('true'),
});

export const cloudRoutes = new Hono<AppEnvironment>();
cloudRoutes.use('/cloud/*', requireAuthentication);

cloudRoutes.post(
  '/cloud/transformations',
  zValidator('json', cloudTransformationRequestSchema, (result) => {
    if (!result.success) {
      throw new ApiError(422, 'invalid_request', 'Invalid transformation request');
    }
  }),
  async (context) => {
    assertCloudProcessingEnabled();
    const idempotencyKey = requireIdempotencyKey(context.req.header('idempotency-key'));
    const input = context.req.valid('json');
    await enforceCloudRateLimits(
      context.get('authUserId'),
      input.deviceId,
      getClientIp(context),
    );
    const result = await processCloudTransformation(
      context.get('authUserId'),
      input,
      idempotencyKey,
    );
    return context.json(cloudTransformationResponseSchema.parse(result));
  },
);

cloudRoutes.post('/cloud/transcriptions', async (context) => {
  assertCloudProcessingEnabled();
  const idempotencyKey = requireIdempotencyKey(context.req.header('idempotency-key'));
  const contentLength = Number(context.req.header('content-length') ?? 0);
  if (contentLength > 4_400_000) {
    throw new ApiError(422, 'audio_too_large', 'Cloud audio payload is too large');
  }
  if (!context.req.header('content-type')?.startsWith('multipart/form-data;')) {
    throw new ApiError(422, 'invalid_content_type', 'Multipart form data is required');
  }

  const form = await context.req.formData();
  const file = form.get('audio');
  const fields = transcriptionFieldsSchema.safeParse({
    deviceId: form.get('deviceId'),
    language: form.get('language') ?? undefined,
    contentTransferAcknowledged: form.get('contentTransferAcknowledged'),
  });
  if (!fields.success || !(file instanceof File)) {
    throw new ApiError(422, 'invalid_request', 'Invalid transcription request');
  }
  await enforceCloudRateLimits(
    context.get('authUserId'),
    fields.data.deviceId,
    getClientIp(context),
  );
  if (file.size > cloudAudioLimits.bytes || file.size === 0) {
    throw new ApiError(422, 'invalid_audio', 'Audio must be a WAV file under 4 MB');
  }
  if (!['audio/wav', 'audio/x-wav', 'application/octet-stream'].includes(file.type)) {
    throw new ApiError(422, 'invalid_audio_type', 'Audio must use the WAV media type');
  }

  const result = await processCloudTranscription(
    context.get('authUserId'),
    fields.data.deviceId,
    Buffer.from(await file.arrayBuffer()),
    fields.data.language,
    idempotencyKey,
  );
  return context.json(cloudTranscriptionResponseSchema.parse(result));
});

function requireIdempotencyKey(value: string | undefined): string {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      422,
      'idempotency_key_required',
      'A valid Idempotency-Key header is required',
    );
  }
  return parsed.data;
}
