import { getEnvironment } from '../env.js';
import { writeLog } from '../lib/logger.js';
import { billingAlerts, needsAttention } from './admin-billing.js';
import type { AdminAlerts } from '../contracts/operations-wire.js';

export interface OpsDigest {
  service: 'pressay-cloud';
  environment: string;
  generatedAt: string;
  attention: boolean;
  counters: Omit<AdminAlerts, 'checkedAt'>;
  /** HTTP status of the optional webhook delivery, or why it was skipped. */
  delivery: number | 'not_configured' | 'failed';
}

/**
 * Daily operations digest: billing counters only (no identifier, no email).
 * Always written to the logs; also posted as JSON to OPS_ALERT_WEBHOOK_URL
 * when that variable is set.
 */
export async function runOpsDigest(fetcher: typeof fetch = fetch): Promise<OpsDigest> {
  const environment = getEnvironment();
  const { checkedAt, ...counters } = await billingAlerts();
  const digest: Omit<OpsDigest, 'delivery'> = {
    service: 'pressay-cloud',
    environment: environment.PRESSAY_DEPLOYMENT_ENV,
    generatedAt: checkedAt,
    attention: needsAttention({ checkedAt, ...counters }),
    counters,
  };
  let delivery: OpsDigest['delivery'] = 'not_configured';
  const url = environment.OPS_ALERT_WEBHOOK_URL;
  if (url) {
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(digest),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      delivery = response.status;
    } catch {
      delivery = 'failed';
    }
  }
  writeLog(digest.attention ? 'warn' : 'info', 'ops_digest.completed', {
    attention: digest.attention,
    failed_webhooks: counters.failed_webhooks,
    failed_webhooks_24h: counters.failed_webhooks_24h,
    open_disputes: counters.open_disputes,
    unpaid_subscriptions: counters.unpaid_subscriptions,
    duplicate_subscriptions: counters.duplicate_subscriptions,
    refunds_24h: counters.refunds_24h,
    failed_payments_24h: counters.failed_payments_24h,
    delivery: String(delivery),
  });
  return { ...digest, delivery };
}
