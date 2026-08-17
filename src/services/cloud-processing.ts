import { createHash } from 'node:crypto';

import type { CloudTransformationRequest } from '../contracts/cloud.ts';
import { ApiError } from '../lib/errors.ts';
import { parseCloudWav } from '../lib/wav.ts';
import { transformWithOpenAI, transcribeWithOpenAI } from './openai-provider.ts';
import { claimUsage, reserveUsage, settleUsage } from './usage-reservations.ts';

const TRANSFORM_ALIAS = 'pressay-transform-v1' as const;
const TRANSCRIBE_ALIAS = 'pressay-transcribe-v1' as const;

function contentHash(parts: readonly (string | Buffer)[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : part;
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest();
}

async function claimOrReject(reservationId: string): Promise<void> {
  if (!(await claimUsage(reservationId))) {
    throw new ApiError(
      409,
      'request_already_handled',
      'This idempotency key is already processing or completed',
    );
  }
}

async function releaseAfterProviderFailure(reservationId: string): Promise<never> {
  await settleUsage(reservationId, false).catch(() => undefined);
  throw new ApiError(
    503,
    'cloud_provider_unavailable',
    'Cloud processing is unavailable',
  );
}

export async function processCloudTransformation(
  authUserId: string,
  input: CloudTransformationRequest,
  idempotencyKey: string,
) {
  const requestHash = contentHash([
    input.deviceId,
    input.instruction,
    input.transcript,
    input.selectedText ?? '',
    input.applicationName ?? '',
    input.language ?? '',
  ]);
  const reservation = await reserveUsage(
    authUserId,
    input.deviceId,
    'cloud_transformation',
    1,
    idempotencyKey,
    requestHash,
  );
  await claimOrReject(reservation.id);

  let result;
  try {
    result = await transformWithOpenAI(input, reservation.id);
  } catch {
    return releaseAfterProviderFailure(reservation.id);
  }
  try {
    await settleUsage(reservation.id, true, result.operationId);
  } catch {
    throw new ApiError(
      503,
      'usage_settlement_unavailable',
      'Cloud result could not be finalized safely',
    );
  }
  return { ...result, modelAlias: TRANSFORM_ALIAS };
}

export async function processCloudTranscription(
  authUserId: string,
  deviceId: string,
  audio: Buffer,
  language: string | undefined,
  idempotencyKey: string,
) {
  const metadata = parseCloudWav(audio);
  const requestHash = contentHash([deviceId, language ?? '', audio]);
  const billedSeconds = Math.max(1, Math.ceil(metadata.durationSeconds));
  const reservation = await reserveUsage(
    authUserId,
    deviceId,
    'cloud_transcription',
    billedSeconds,
    idempotencyKey,
    requestHash,
  );
  await claimOrReject(reservation.id);

  let result;
  try {
    result = await transcribeWithOpenAI(audio, language, reservation.id);
  } catch {
    return releaseAfterProviderFailure(reservation.id);
  }
  try {
    await settleUsage(reservation.id, true, result.operationId);
  } catch {
    throw new ApiError(
      503,
      'usage_settlement_unavailable',
      'Cloud result could not be finalized safely',
    );
  }
  return {
    ...result,
    modelAlias: TRANSCRIBE_ALIAS,
    durationSeconds: metadata.durationSeconds,
  };
}
