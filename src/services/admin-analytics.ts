import { getSql } from '../db/client.js';
import { csvDocument } from '../lib/csv.js';
import { adminAdvancedMetricsSchema } from '../contracts/operations.js';
import type {
  AdminAdvancedMetrics,
  MetricExportDataset,
} from '../contracts/operations-wire.js';

/**
 * Churn, conversion and trial indicators from the subscription history
 * (billing_subscription_transition, migration 0028), and download breakdowns
 * from the anonymous download_event table. Aggregates only: no account id,
 * email or provider identifier leaves these queries. Apple Sandbox (App
 * Review, TestFlight) is excluded everywhere.
 */

/** Statuses in which a subscription is paying. */
export const PAYING_STATUSES = ['active', 'past_due', 'grace'] as const;

/** UTC calendar months, oldest first, the current one last. */
const MONTHS = `months AS (
  SELECT series AS month_start
  FROM generate_series(
    date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => $1::int - 1),
    date_trunc('month', now() AT TIME ZONE 'UTC'),
    interval '1 month'
  ) AS series
)`;
const PRODUCTION = `production AS (
  SELECT * FROM billing_subscription_transition WHERE environment = 'Production'
)`;

async function churnRows(months: number) {
  return getSql().query(
    `WITH ${MONTHS}, ${PRODUCTION}
    SELECT to_char(m.month_start, 'YYYY-MM') AS month,
      (
        SELECT count(*) FROM (
          SELECT DISTINCT ON (t.subscription_id) t.to_status
          FROM production t
          WHERE t.occurred_at < m.month_start AT TIME ZONE 'UTC'
          ORDER BY t.subscription_id, t.occurred_at DESC, t.id DESC
        ) latest
        WHERE latest.to_status = ANY($2::text[])
      )::int AS paying_start,
      (
        SELECT count(*) FROM production t
        WHERE t.occurred_at >= m.month_start AT TIME ZONE 'UTC'
          AND t.occurred_at < (m.month_start + interval '1 month') AT TIME ZONE 'UTC'
          AND NOT t.backfilled
          AND t.to_status = ANY($2::text[])
          AND (t.from_status IS NULL OR NOT t.from_status = ANY($2::text[]))
      )::int AS new_paying,
      (
        SELECT count(*) FROM production t
        WHERE t.occurred_at >= m.month_start AT TIME ZONE 'UTC'
          AND t.occurred_at < (m.month_start + interval '1 month') AT TIME ZONE 'UTC'
          AND t.from_status = ANY($2::text[])
          AND NOT t.to_status = ANY($2::text[])
          AND t.to_status <> 'trialing'
      )::int AS churned
    FROM months m ORDER BY m.month_start`,
    [months, PAYING_STATUSES],
  );
}

/**
 * Accounts by sign-up month. An account converted when one of its Production
 * subscriptions reached a paying status, or a Stripe invoice with an amount
 * was paid (which also covers customers who paid and left before the history
 * started).
 */
async function cohortRows(months: number) {
  return getSql().query(
    `WITH ${MONTHS}, ${PRODUCTION},
    conversion AS (
      SELECT account_id, min(at) AS converted_at FROM (
        SELECT account_id, occurred_at AS at FROM production
        WHERE to_status = ANY($2::text[])
        UNION ALL
        SELECT account_id, provider_occurred_at FROM billing_financial_event
        WHERE kind = 'invoice_paid' AND amount_minor > 0 AND account_id IS NOT NULL
      ) paid
      GROUP BY account_id
    ),
    trial AS (SELECT DISTINCT account_id FROM production WHERE to_status = 'trialing')
    SELECT to_char(m.month_start, 'YYYY-MM') AS month,
      count(a.id)::int AS signups,
      count(c.account_id)::int AS converted,
      count(c.account_id) FILTER (
        WHERE c.converted_at < a.created_at + interval '30 days'
      )::int AS converted_30d,
      count(tr.account_id)::int AS trials
    FROM months m
    LEFT JOIN pressay_account a
      ON a.created_at >= m.month_start AT TIME ZONE 'UTC'
      AND a.created_at < (m.month_start + interval '1 month') AT TIME ZONE 'UTC'
    LEFT JOIN conversion c ON c.account_id = a.id
    LEFT JOIN trial tr ON tr.account_id = a.id
    GROUP BY m.month_start ORDER BY m.month_start`,
    [months, PAYING_STATUSES],
  );
}

/**
 * Trials by the month they started, with what happened next to the same
 * subscription: paid (converted), stopped (ended) or nothing yet (running).
 */
async function trialRows(months: number) {
  return getSql().query(
    `WITH ${MONTHS}, ${PRODUCTION},
    outcome AS (
      SELECT start.id, start.occurred_at, (
        SELECT next.to_status FROM production next
        WHERE next.subscription_id = start.subscription_id
          AND (next.occurred_at, next.id) > (start.occurred_at, start.id)
          AND next.to_status <> 'trialing'
        ORDER BY next.occurred_at, next.id LIMIT 1
      ) AS next_status
      FROM production start
      WHERE start.to_status = 'trialing'
    )
    SELECT to_char(m.month_start, 'YYYY-MM') AS month,
      count(o.id)::int AS started,
      count(o.id) FILTER (WHERE o.next_status = ANY($2::text[]))::int AS converted,
      count(o.id) FILTER (
        WHERE o.next_status IS NOT NULL AND NOT o.next_status = ANY($2::text[])
      )::int AS ended,
      count(o.id) FILTER (WHERE o.id IS NOT NULL AND o.next_status IS NULL)::int AS running
    FROM months m
    LEFT JOIN outcome o
      ON o.occurred_at >= m.month_start AT TIME ZONE 'UTC'
      AND o.occurred_at < (m.month_start + interval '1 month') AT TIME ZONE 'UTC'
    GROUP BY m.month_start ORDER BY m.month_start`,
    [months, PAYING_STATUSES],
  );
}

const RECENT_DOWNLOADS = `download_event WHERE created_at > now() - make_interval(days => $1::int)`;

export async function advancedMetrics(input: {
  months: number;
  days: number;
}): Promise<AdminAdvancedMetrics> {
  const sql = getSql();
  const [churn, cohorts, trials, history, platforms, versions, sources, campaigns] =
    await Promise.all([
      churnRows(input.months),
      cohortRows(input.months),
      trialRows(input.months),
      sql.query(
        'SELECT min(recorded_at) AS started_at FROM billing_subscription_transition',
        [],
      ),
      sql.query(
        `SELECT platform, count(*)::int AS count FROM ${RECENT_DOWNLOADS}
        GROUP BY 1 ORDER BY 2 DESC, 1`,
        [input.days],
      ),
      sql.query(
        `SELECT platform, app_version, count(*)::int AS count FROM ${RECENT_DOWNLOADS}
        GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LIMIT 50`,
        [input.days],
      ),
      sql.query(
        `SELECT source, count(*)::int AS count FROM ${RECENT_DOWNLOADS}
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50`,
        [input.days],
      ),
      sql.query(
        `SELECT campaign, count(*)::int AS count FROM ${RECENT_DOWNLOADS}
          AND campaign IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50`,
        [input.days],
      ),
    ]);
  return adminAdvancedMetricsSchema.parse({
    months: input.months,
    days: input.days,
    historyStartedAt: (history[0]?.started_at as Date | null | undefined) ?? null,
    churn,
    cohorts,
    trials,
    downloads: { platforms, versions, sources, campaigns },
    generatedAt: new Date().toISOString(),
  });
}

/** Share of `part` in `whole` with four decimals, empty when undefined. */
function rate(part: number, whole: number): string {
  return whole > 0 ? (part / whole).toFixed(4) : '';
}

/**
 * One dataset as CSV. Every cell goes through csvField, which neutralises
 * formula prefixes: download sources and campaigns come from public URLs.
 */
export async function metricExport(
  dataset: MetricExportDataset,
  query: { months?: number; days?: number },
): Promise<{ csv: string; rows: number }> {
  const months = query.months ?? 12;
  const days = query.days ?? 30;
  let header: string[];
  let rows: (string | number | null)[][];
  switch (dataset) {
    case 'churn': {
      const parsed = adminAdvancedMetricsSchema.shape.churn.parse(
        await churnRows(months),
      );
      header = ['month', 'paying_start', 'new_paying', 'churned', 'churn_rate'];
      rows = parsed.map((r) => [
        r.month,
        r.paying_start,
        r.new_paying,
        r.churned,
        rate(r.churned, r.paying_start),
      ]);
      break;
    }
    case 'cohorts': {
      const parsed = adminAdvancedMetricsSchema.shape.cohorts.parse(
        await cohortRows(months),
      );
      header = [
        'month',
        'signups',
        'converted',
        'conversion_rate',
        'converted_30d',
        'conversion_rate_30d',
        'trials',
      ];
      rows = parsed.map((r) => [
        r.month,
        r.signups,
        r.converted,
        rate(r.converted, r.signups),
        r.converted_30d,
        rate(r.converted_30d, r.signups),
        r.trials,
      ]);
      break;
    }
    case 'trials': {
      const parsed = adminAdvancedMetricsSchema.shape.trials.parse(
        await trialRows(months),
      );
      header = ['month', 'started', 'converted', 'ended', 'running', 'conversion_rate'];
      rows = parsed.map((r) => [
        r.month,
        r.started,
        r.converted,
        r.ended,
        r.running,
        rate(r.converted, r.converted + r.ended),
      ]);
      break;
    }
    case 'downloads': {
      const result = await getSql().query(
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
          platform, asset_type, app_version, source, campaign, count(*)::int AS count
        FROM ${RECENT_DOWNLOADS}
        GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 3, 4, 5, 6`,
        [days],
      );
      header = [
        'day',
        'platform',
        'asset_type',
        'app_version',
        'source',
        'campaign',
        'count',
      ];
      rows = result.map((r) => [
        String(r.day),
        String(r.platform),
        String(r.asset_type),
        String(r.app_version),
        String(r.source),
        r.campaign === null ? null : String(r.campaign),
        Number(r.count),
      ]);
      break;
    }
    case 'signups': {
      const result = await getSql().query(
        `SELECT to_char(series.day, 'YYYY-MM-DD') AS day, count(a.id)::int AS count
        FROM generate_series(
          (now() AT TIME ZONE 'UTC')::date - ($1::int - 1),
          (now() AT TIME ZONE 'UTC')::date,
          interval '1 day'
        ) AS series(day)
        LEFT JOIN pressay_account a
          ON (a.created_at AT TIME ZONE 'UTC')::date = series.day::date
        GROUP BY 1 ORDER BY 1`,
        [days],
      );
      header = ['day', 'signups'];
      rows = result.map((r) => [String(r.day), Number(r.count)]);
      break;
    }
  }
  return { csv: csvDocument(header, rows), rows: rows.length };
}
