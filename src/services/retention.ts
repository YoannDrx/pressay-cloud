import { z } from 'zod';

import { getSql } from '../db/client.js';
import { getEnvironment } from '../env.js';

/** Rows removed per table and run, so one cron invocation stays short. */
const PURGE_BATCH_SIZE = 5_000;

const deletedSchema = z.object({
  deleted_count: z.coerce.number().int().nonnegative(),
});

export interface PurgeResult {
  idempotencyRecords: number;
  operationsRequests: number;
  usageReservations: number;
  providerEvents: number;
  legacySessions: number;
  legacyVerifications: number;
}

async function deleteBatch(sql: string, values: unknown[]): Promise<number> {
  const rows = await getSql().query(
    `WITH deleted AS (${sql} RETURNING 1)
    SELECT count(*)::integer AS deleted_count FROM deleted`,
    values,
  );
  const parsed = deletedSchema.safeParse(rows[0]);
  return parsed.success ? parsed.data.deleted_count : 0;
}

/**
 * Remove operational records that have outlived their purpose (see the
 * retention matrix in docs/ARCHITECTURE.md). Never touches accounting records:
 * provider events that carry a billing_financial_event row, the financial
 * ledger itself and operations_audit are kept.
 */
export async function purgeExpiredRecords(): Promise<PurgeResult> {
  const environment = getEnvironment();
  const idempotencyRecords = await deleteBatch(
    `DELETE FROM idempotency_record
    WHERE ctid IN (
      SELECT ctid FROM idempotency_record
      WHERE expires_at < now()
        AND created_at < now() - make_interval(days => $1)
        AND state <> 'processing'
      LIMIT $2
    )`,
    [environment.PRESSAY_RETENTION_IDEMPOTENCY_DAYS, PURGE_BATCH_SIZE],
  );
  // Idempotency keys of administrative actions (no personal data).
  const operationsRequests = await deleteBatch(
    `DELETE FROM operations_request
    WHERE ctid IN (
      SELECT ctid FROM operations_request
      WHERE created_at < now() - make_interval(days => $1)
      LIMIT $2
    )`,
    [environment.PRESSAY_RETENTION_IDEMPOTENCY_DAYS, PURGE_BATCH_SIZE],
  );
  const usageReservations = await deleteBatch(
    `DELETE FROM usage_reservation
    WHERE ctid IN (
      SELECT ctid FROM usage_reservation
      WHERE status IN ('finalized', 'released', 'expired')
        AND created_at < now() - make_interval(days => $1)
      LIMIT $2
    )`,
    [environment.PRESSAY_RETENTION_USAGE_RESERVATION_DAYS, PURGE_BATCH_SIZE],
  );
  const providerEvents = await deleteBatch(
    `DELETE FROM provider_event event
    WHERE event.ctid IN (
      SELECT candidate.ctid FROM provider_event candidate
      WHERE candidate.state IN ('applied', 'ignored')
        AND candidate.received_at < now() - make_interval(days => $1)
        AND NOT EXISTS (
          SELECT 1 FROM billing_financial_event financial
          WHERE financial.provider = candidate.provider
            AND financial.provider_event_id = candidate.provider_event_id
        )
      LIMIT $2
    )`,
    [environment.PRESSAY_RETENTION_PROVIDER_EVENT_DAYS, PURGE_BATCH_SIZE],
  );
  // Cloud no longer issues sessions (identity moved to the web); expired rows
  // from the retired Better Auth instance are removed.
  const legacySessions = await deleteBatch(
    `DELETE FROM "session"
    WHERE ctid IN (SELECT ctid FROM "session" WHERE "expiresAt" < now() LIMIT $1)`,
    [PURGE_BATCH_SIZE],
  );
  const legacyVerifications = await deleteBatch(
    `DELETE FROM "verification"
    WHERE ctid IN (SELECT ctid FROM "verification" WHERE "expiresAt" < now() LIMIT $1)`,
    [PURGE_BATCH_SIZE],
  );
  return {
    idempotencyRecords,
    operationsRequests,
    usageReservations,
    providerEvents,
    legacySessions,
    legacyVerifications,
  };
}
