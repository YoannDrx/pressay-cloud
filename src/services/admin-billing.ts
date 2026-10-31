import type { z } from 'zod';

import { getSql } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import {
  adminAlertsSchema,
  adminFinancialEventsSchema,
  adminProviderEventsSchema,
  type financialEventQuerySchema,
  type providerEventQuerySchema,
  type supportActionSchema,
} from '../contracts/operations.js';
import type {
  AdminAlerts,
  AdminFinancialEvents,
  AdminProviderEvents,
  ProviderEventReplay,
} from '../contracts/operations-wire.js';
import { audited, type Operator } from './admin-support.js';
import { replayStripeEvent } from './billing.js';

type FinancialEventQuery = z.infer<typeof financialEventQuerySchema>;
type ProviderEventQuery = z.infer<typeof providerEventQuerySchema>;

/** Stripe dispute statuses that still need an answer or a decision. */
export const OPEN_DISPUTE_STATUSES = [
  'warning_needs_response',
  'warning_under_review',
  'needs_response',
  'under_review',
];

/**
 * Keyset cursor `<timestamp>|<event id>` (newest first). The timestamp is
 * PostgreSQL's own JSON rendering, which keeps microseconds.
 */
function decodeCursor(cursor: string | undefined): [string, string] | [null, null] {
  if (!cursor) return [null, null];
  const separator = cursor.indexOf('|');
  const time = cursor.slice(0, separator);
  if (
    separator < 1 ||
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}(:\d{2})?)$/.test(time) ||
    Number.isNaN(Date.parse(time))
  )
    throw new ApiError(422, 'invalid_cursor', 'Invalid cursor');
  return [time, cursor.slice(separator + 1)];
}
function encodeCursor(row: Record<string, unknown> | undefined): string | null {
  return row ? `${String(row.cursor_time)}|${String(row.cursor_id)}` : null;
}

/**
 * Refunds, disputes, failed payments (or any ledger kind), 50 per page, with
 * the customer's account and email. `open` keeps disputes whose latest
 * status still needs action.
 */
export async function financialEvents(
  query: FinancialEventQuery,
): Promise<AdminFinancialEvents> {
  const [time, id] = decodeCursor(query.cursor);
  const rows = await getSql().query(
    `SELECT f.provider_event_id,f.provider_object_id,f.provider_subscription_id,f.kind,f.status,
      f.amount_minor,f.currency,f.full_reversal,f.provider_occurred_at,f.account_id,c.email,
      to_json(f.provider_occurred_at)#>>'{}' AS cursor_time,f.provider_event_id AS cursor_id
    FROM billing_financial_event f
    LEFT JOIN account_contact c ON c.account_id=f.account_id
    WHERE ($1='' OR f.kind=$1)
      AND (NOT $2::boolean OR (
        f.kind='dispute' AND f.status=ANY($3::text[])
        AND NOT EXISTS (
          SELECT 1 FROM billing_financial_event later
          WHERE later.provider=f.provider AND later.provider_object_id=f.provider_object_id
            AND later.provider_occurred_at>f.provider_occurred_at
        )
      ))
      AND ($4::timestamptz IS NULL
        OR (f.provider_occurred_at,f.provider_event_id)<($4::timestamptz,$5::text))
    ORDER BY f.provider_occurred_at DESC,f.provider_event_id DESC LIMIT 51`,
    [query.kind, query.open, OPEN_DISPUTE_STATUSES, time, id],
  );
  return adminFinancialEventsSchema.parse({
    events: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? encodeCursor(rows[49]) : null,
  });
}

/** Provider events (webhooks), 50 per page, filtered by state and provider. */
export async function providerEvents(
  query: ProviderEventQuery,
): Promise<AdminProviderEvents> {
  const [time, id] = decodeCursor(query.cursor);
  const rows = await getSql().query(
    `SELECT provider,provider_event_id,event_type,state,error_code,received_at,processed_at,
      account_id,to_json(received_at)#>>'{}' AS cursor_time,provider_event_id AS cursor_id
    FROM provider_event
    WHERE ($1='' OR state=$1) AND ($2='' OR provider=$2)
      AND ($3::timestamptz IS NULL OR (received_at,provider_event_id)<($3::timestamptz,$4::text))
    ORDER BY received_at DESC,provider_event_id DESC LIMIT 51`,
    [query.state, query.provider, time, id],
  );
  return adminProviderEventsSchema.parse({
    events: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? encodeCursor(rows[49]) : null,
  });
}

/**
 * Billing situations that need a person: failed webhooks, open disputes,
 * unpaid subscriptions and accounts paying twice. Counts only, Production
 * subscriptions only (Apple Sandbox is never billed).
 */
export async function billingAlerts(): Promise<AdminAlerts> {
  const rows = await getSql().query(
    `SELECT
      (SELECT count(*)::int FROM provider_event WHERE state='failed') AS failed_webhooks,
      (SELECT count(*)::int FROM provider_event
        WHERE state='failed' AND received_at>now()-interval '24 hours') AS failed_webhooks_24h,
      (SELECT count(*)::int FROM (
        SELECT DISTINCT ON (provider_object_id) status FROM billing_financial_event
        WHERE kind='dispute' ORDER BY provider_object_id,provider_occurred_at DESC
      ) latest WHERE status=ANY($1::text[])) AS open_disputes,
      (SELECT count(*)::int FROM billing_subscription
        WHERE apple_environment='Production' AND status IN ('past_due','grace')
          AND current_period_ends_at>now()-interval '30 days') AS unpaid_subscriptions,
      (SELECT count(*)::int FROM (
        SELECT account_id FROM billing_subscription
        WHERE apple_environment='Production' AND status IN ('trialing','active','past_due','grace')
          AND current_period_ends_at>now()
        GROUP BY account_id HAVING count(*)>1
      ) duplicates) AS duplicate_subscriptions,
      (SELECT count(*)::int FROM billing_financial_event
        WHERE kind='refund' AND provider_occurred_at>now()-interval '24 hours') AS refunds_24h,
      (SELECT count(*)::int FROM billing_financial_event
        WHERE kind='invoice_failed' AND provider_occurred_at>now()-interval '24 hours') AS failed_payments_24h`,
    [OPEN_DISPUTE_STATUSES],
  );
  return adminAlertsSchema.parse({ ...rows[0], checkedAt: new Date().toISOString() });
}

/** Whether any alert needs someone today. */
export function needsAttention(alerts: AdminAlerts): boolean {
  return (
    alerts.failed_webhooks > 0 ||
    alerts.open_disputes > 0 ||
    alerts.unpaid_subscriptions > 0 ||
    alerts.duplicate_subscriptions > 0
  );
}

/** Support replay of a failed Stripe event, audited with its outcome. */
export async function replayProviderEvent(
  operator: Operator,
  provider: string,
  eventId: string,
  input: z.infer<typeof supportActionSchema>,
): Promise<ProviderEventReplay> {
  if (provider !== 'stripe')
    throw new ApiError(
      422,
      'replay_unsupported',
      'Only Stripe events can be replayed; Apple retries its notifications itself',
    );
  const owner = await getSql().query(
    "SELECT account_id FROM provider_event WHERE provider='stripe' AND provider_event_id=$1",
    [eventId],
  );
  const accountId =
    typeof owner[0]?.account_id === 'string' ? owner[0].account_id : null;
  return audited(
    operator,
    'billing.event.replay',
    `stripe/${eventId}`,
    input.reason,
    accountId,
    async () => {
      const result = await replayStripeEvent(eventId);
      if (result.state === 'failed')
        throw new ApiError(
          409,
          'replay_failed',
          `The event failed again (${result.errorCode ?? 'unknown'})`,
        );
      return {
        value: { provider: 'stripe' as const, eventId, ...result },
        accountId: result.accountId ?? accountId,
        details: { state: result.state, errorCode: result.errorCode },
      };
    },
  );
}
