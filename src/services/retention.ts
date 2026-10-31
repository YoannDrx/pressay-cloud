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
  waitlistEntries: number;
  auditReads: number;
  auditActions: number;
  restrictedEmails: number;
}

/** Audit reasons of reads and exports, kept PRESSAY_RETENTION_AUDIT_READ_DAYS. */
export const AUDIT_READ_REASONS = ['personal_data_read', 'data_export'];

async function countUpdated(sql: string, values: unknown[]): Promise<number> {
  const rows = await getSql().query(
    `WITH updated AS (${sql} RETURNING 1)
    SELECT count(*)::integer AS deleted_count FROM updated`,
    values,
  );
  const parsed = deletedSchema.safeParse(rows[0]);
  return parsed.success ? parsed.data.deleted_count : 0;
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
 * provider events that carry a billing_financial_event row and the financial
 * ledger itself are kept.
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
  // Waitlists: consent lapses after PRESSAY_RETENTION_WAITLIST_DAYS, and an
  // unsubscribed address is kept 30 days only (to honour the request).
  const waitlistEntries = await deleteBatch(
    `DELETE FROM waitlist_entry
    WHERE ctid IN (
      SELECT ctid FROM waitlist_entry
      WHERE consent_at < now() - make_interval(days => $1)
        OR unsubscribed_at < now() - interval '30 days'
      LIMIT $2
    )`,
    [environment.PRESSAY_RETENTION_WAITLIST_DAYS, PURGE_BATCH_SIZE],
  );
  // Audit ledger: reads and exports expire sooner than actions.
  const auditReads = await deleteBatch(
    `DELETE FROM operations_audit
    WHERE ctid IN (
      SELECT ctid FROM operations_audit
      WHERE reason = ANY($3::text[])
        AND created_at < now() - make_interval(days => $1)
      LIMIT $2
    )`,
    [
      environment.PRESSAY_RETENTION_AUDIT_READ_DAYS,
      PURGE_BATCH_SIZE,
      AUDIT_READ_REASONS,
    ],
  );
  const auditActions = await deleteBatch(
    `DELETE FROM operations_audit
    WHERE ctid IN (
      SELECT ctid FROM operations_audit
      WHERE NOT reason = ANY($3::text[])
        AND created_at < now() - make_interval(days => $1)
      LIMIT $2
    )`,
    [
      environment.PRESSAY_RETENTION_AUDIT_ACTION_DAYS,
      PURGE_BATCH_SIZE,
      AUDIT_READ_REASONS,
    ],
  );
  // An invitation reserved to an address keeps that address only while it can
  // still be redeemed.
  const restrictedEmails = await countUpdated(
    `UPDATE access_campaign SET restricted_email = NULL
    WHERE id IN (
      SELECT id FROM access_campaign
      WHERE restricted_email IS NOT NULL
        AND (
          expires_at < now()
          OR status IN ('revoked', 'failed')
          OR redemptions >= max_redemptions
        )
      LIMIT $1
    )`,
    [PURGE_BATCH_SIZE],
  );
  return {
    idempotencyRecords,
    operationsRequests,
    usageReservations,
    providerEvents,
    legacySessions,
    legacyVerifications,
    waitlistEntries,
    auditReads,
    auditActions,
    restrictedEmails,
  };
}
