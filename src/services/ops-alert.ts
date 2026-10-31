import { getEnvironment } from '../env.js';
import { writeLog } from '../lib/logger.js';

/** An administrator was added, changed role, removed, or claimed the owner seat. */
export interface MemberAlert {
  event: 'operations_member.changed' | 'operations_member.owner_claimed';
  /** Account whose access changed. Identifiers only: no email. */
  accountId: string;
  /** Owner who made the change (the account itself for a claim). */
  actorAccountId: string;
  previousRole: string | null;
  role: string | null;
  requestId: string;
}

/**
 * Posts an access change to OPS_ALERT_WEBHOOK_URL when it is set, and logs
 * it either way. Never throws: the change is already committed and audited.
 */
export async function alertMemberChange(
  alert: MemberAlert,
  fetcher: typeof fetch = fetch,
): Promise<number | 'not_configured' | 'failed'> {
  const environment = getEnvironment();
  let delivery: number | 'not_configured' | 'failed' = 'not_configured';
  const url = environment.OPS_ALERT_WEBHOOK_URL;
  if (url) {
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: 'pressay-cloud',
          environment: environment.PRESSAY_DEPLOYMENT_ENV,
          ...alert,
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      delivery = response.status;
    } catch {
      delivery = 'failed';
    }
  }
  writeLog('warn', 'ops_alert.member_changed', {
    event: alert.event,
    role: alert.role ?? 'none',
    previous_role: alert.previousRole ?? 'none',
    request_id: alert.requestId,
    delivery: String(delivery),
  });
  return delivery;
}
