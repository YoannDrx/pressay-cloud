import { z } from 'zod';

import { getSql } from '../db/client.ts';
import { ApiError } from '../lib/errors.ts';

export type UsageKind = 'cloud_transcription' | 'cloud_transformation';

const reservationRowSchema = z.object({
  result_reservation_id: z.uuid(),
  result_status: z.enum(['reserved', 'finalized', 'released', 'expired']),
  result_units: z.coerce.number().int().positive(),
  result_expires_at: z.coerce.date(),
});

export interface UsageReservation {
  id: string;
  status: 'reserved' | 'finalized' | 'released' | 'expired';
  units: number;
  expiresAt: string;
}

function mapReservationError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  const mappings: readonly (readonly [string, ApiError])[] = [
    [
      'cloud_entitlement_required',
      new ApiError(
        403,
        'cloud_entitlement_required',
        'A current Pro entitlement is required',
      ),
    ],
    [
      'device_not_active',
      new ApiError(403, 'device_not_active', 'Device is not active'),
    ],
    [
      'usage_quota_exceeded',
      new ApiError(429, 'usage_quota_exceeded', 'Monthly Cloud quota has been reached'),
    ],
    [
      'idempotency_conflict',
      new ApiError(409, 'idempotency_conflict', 'Idempotency key was used differently'),
    ],
  ];
  for (const [databaseCode, apiError] of mappings) {
    if (message.includes(databaseCode)) throw apiError;
  }
  throw error;
}

export async function reserveUsage(
  authUserId: string,
  deviceId: string,
  kind: UsageKind,
  units: number,
  idempotencyKey: string,
): Promise<UsageReservation> {
  try {
    const rows = await getSql().query(
      'SELECT * FROM reserve_pressay_usage($1, $2, $3, $4, $5)',
      [authUserId, deviceId, kind, units, idempotencyKey],
    );
    const row = reservationRowSchema.parse(rows[0]);
    return {
      id: row.result_reservation_id,
      status: row.result_status,
      units: row.result_units,
      expiresAt: row.result_expires_at.toISOString(),
    };
  } catch (error) {
    return mapReservationError(error);
  }
}

export async function settleUsage(
  reservationId: string,
  succeeded: boolean,
  providerOperationId?: string,
): Promise<'finalized' | 'released' | 'expired'> {
  const rows = await getSql().query(
    'SELECT settle_pressay_usage($1, $2, $3) AS status',
    [reservationId, succeeded, providerOperationId ?? null],
  );
  return z
    .object({ status: z.enum(['finalized', 'released', 'expired']) })
    .parse(rows[0]).status;
}
