import { getSql } from '../db/client.js';
import { getEnvironment } from '../env.js';
import { adminMetricsSchema } from '../contracts/operations.js';
import type { AdminMetrics } from '../contracts/operations-wire.js';

/**
 * Commercial indicators for the owner. Aggregates only: no account id, email
 * or provider identifier. Apple Sandbox (App Review, TestFlight) is never
 * counted as paid and trials are reported apart from paying subscribers.
 *
 * MRR is the monthly value of Production subscriptions that are paying now
 * (active, past due within grace, Apple billing grace) at the price stored on
 * the subscription (annual / 12), as charged to the customer: taxes included,
 * before Stripe or Apple fees. Rows without a stored price use the catalogue
 * and are counted in `estimatedSubscriptions`.
 */
export async function adminMetrics(): Promise<AdminMetrics> {
  const environment = getEnvironment();
  const sql = getSql();
  const catalogue = [
    environment.PRESSAY_PRO_MONTHLY_AMOUNT_MINOR,
    environment.PRESSAY_PRO_ANNUAL_AMOUNT_MINOR,
    environment.PRESSAY_APP_STORE_MONTHLY_AMOUNT_MINOR ??
      environment.PRESSAY_PRO_MONTHLY_AMOUNT_MINOR,
    environment.PRESSAY_APP_STORE_ANNUAL_AMOUNT_MINOR ??
      environment.PRESSAY_PRO_ANNUAL_AMOUNT_MINOR,
    environment.PRESSAY_PRO_CURRENCY,
  ];
  const [subscribers, revenue, signups, activity, grants, collected, downloads] =
    await Promise.all([
      sql.query(
        `SELECT provider,billing_interval,status,apple_environment AS environment,
          count(*)::int AS count
        FROM billing_subscription
        WHERE status IN ('trialing','active','past_due','grace') AND current_period_ends_at>now()
        GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,
        [],
      ),
      sql.query(
        `WITH priced AS (
          SELECT provider,
            COALESCE(amount_minor, CASE
              WHEN provider='stripe' AND billing_interval='month' THEN $1::int
              WHEN provider='stripe' THEN $2::int
              WHEN billing_interval='month' THEN $3::int
              ELSE $4::int END) AS amount_minor,
            COALESCE(currency,$5::text) AS currency,
            billing_interval,
            amount_minor IS NULL AS estimated
          FROM billing_subscription
          WHERE apple_environment='Production' AND status IN ('active','past_due','grace')
            AND current_period_ends_at>now()
        )
        SELECT provider,currency,
          round(sum(CASE WHEN billing_interval='year' THEN amount_minor/12.0 ELSE amount_minor END))::int
            AS mrr_minor,
          count(*)::int AS subscriptions,
          count(*) FILTER (WHERE estimated)::int AS estimated_subscriptions
        FROM priced GROUP BY 1,2 ORDER BY 1,2`,
        catalogue,
      ),
      sql.query(
        `SELECT to_char(series.day,'YYYY-MM-DD') AS day,count(a.id)::int AS count
        FROM generate_series(
          (now() AT TIME ZONE 'UTC')::date - 29,
          (now() AT TIME ZONE 'UTC')::date,
          interval '1 day'
        ) AS series(day)
        LEFT JOIN pressay_account a
          ON (a.created_at AT TIME ZONE 'UTC')::date = series.day::date
        GROUP BY 1 ORDER BY 1`,
        [],
      ),
      sql.query(
        `SELECT
          count(DISTINCT d.account_id) FILTER (WHERE d.last_seen_at>now()-interval '7 days')::int
            AS active_7d,
          count(DISTINCT d.account_id) FILTER (WHERE d.last_seen_at>now()-interval '30 days')::int
            AS active_30d
        FROM pressay_device d JOIN pressay_account a ON a.id=d.account_id
        WHERE a.status='active' AND d.revoked_at IS NULL`,
        [],
      ),
      sql.query(
        `SELECT source,count(*)::int AS count FROM access_grant
        WHERE revoked_at IS NULL AND starts_at<=now() AND ends_at>now()
        GROUP BY 1 ORDER BY 1`,
        [],
      ),
      sql.query(
        `SELECT currency,
          COALESCE(sum(amount_minor) FILTER (WHERE kind='invoice_paid'),0)::bigint AS paid_minor,
          COALESCE(sum(amount_minor) FILTER (WHERE kind='refund'),0)::bigint AS refunded_minor,
          count(*) FILTER (WHERE kind='invoice_paid')::int AS invoices
        FROM billing_financial_event
        WHERE provider_occurred_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          AND kind IN ('invoice_paid','refund')
        GROUP BY 1 ORDER BY 1`,
        [],
      ),
      sql.query(
        `SELECT platform,app_version,
          count(*) FILTER (WHERE created_at>now()-interval '7 days')::int AS last_7d,
          count(*)::int AS last_30d
        FROM download_event WHERE created_at>now()-interval '30 days'
        GROUP BY 1,2 ORDER BY 4 DESC,1,2 LIMIT 50`,
        [],
      ),
    ]);
  const mrr = revenue.map((row) => ({
    ...row,
    arr_minor: Number(row.mrr_minor) * 12,
  }));
  return adminMetricsSchema.parse({
    subscribers,
    mrr,
    signups,
    activeAccounts: activity[0] ?? { active_7d: 0, active_30d: 0 },
    grants,
    collectedThisMonth: collected,
    downloads,
    generatedAt: new Date().toISOString(),
  });
}
