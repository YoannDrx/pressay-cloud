import { getSql } from '../db/client.js';
import { writeLog } from '../lib/logger.js';

export type BillingProvider = 'stripe' | 'apple';

/**
 * Persist a processing failure for a verified provider event so operators see
 * it in /admin/overview and /admin/billing/events. Only a stable code is
 * stored. A later provider retry resets the row to `received` and reprocesses
 * it (see the `incoming` CTEs), so recording a failure never blocks recovery.
 */
export async function recordFailedProviderEvent(input: {
  provider: BillingProvider;
  eventId: string;
  payloadHash: string;
  eventType: string;
  occurredAtMs: number;
  errorCode: string;
}): Promise<void> {
  writeLog('error', 'billing.webhook.failed', {
    provider: input.provider,
    code: input.errorCode,
    event_type: input.eventType,
  });
  try {
    await getSql().query(
      `INSERT INTO provider_event (
        provider, provider_event_id, payload_sha256, event_type,
        provider_occurred_at, state, error_code, processed_at
      ) VALUES (
        $1, $2, decode($3, 'hex'), $4, to_timestamp($5 / 1000.0), 'failed', $6, now()
      )
      ON CONFLICT (provider, provider_event_id) DO UPDATE SET
        state = 'failed',
        error_code = EXCLUDED.error_code,
        processed_at = now()
      WHERE provider_event.state IN ('received', 'failed')`,
      [
        input.provider,
        input.eventId,
        input.payloadHash,
        input.eventType.slice(0, 160),
        input.occurredAtMs,
        input.errorCode.slice(0, 120),
      ],
    );
  } catch {
    // The provider retries the delivery; the log line above is the fallback.
  }
}

/** Insert clause shared by projections: new events, or retries of failed ones. */
export const RETRYABLE_PROVIDER_EVENT_CONFLICT = `ON CONFLICT (provider, provider_event_id) DO UPDATE SET
          state = 'received',
          error_code = NULL,
          processed_at = NULL,
          payload_sha256 = EXCLUDED.payload_sha256
        WHERE provider_event.state = 'failed'`;

/** Conflict clause for terminal `ignored` records: only a failed attempt is replaced. */
export const IGNORED_PROVIDER_EVENT_CONFLICT = `ON CONFLICT (provider, provider_event_id) DO UPDATE SET
          state = 'ignored',
          error_code = EXCLUDED.error_code,
          processed_at = now()
        WHERE provider_event.state = 'failed'`;
