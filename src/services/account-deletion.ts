import { z } from 'zod';

import { getStripe } from '../billing/stripe-client.js';
import { getSql } from '../db/client.js';
import { writeLog } from '../lib/logger.js';
import { deleteWebIdentity, WebIdentityDeletionError } from './web-identity.js';

const deletionJobSchema = z.object({
  account_id: z.uuid(),
  auth_user_id: z.string(),
  stripe_customer_id: z.string().nullable(),
  apple_subscription_active: z.boolean().default(false),
  attempts: z.coerce.number().int().min(1).max(20),
});

interface DeletionJob {
  accountId: string;
  authUserId: string;
  stripeCustomerId: string | null;
  appleSubscriptionActive: boolean;
  attempts: number;
}

async function claimDeletionJob(): Promise<DeletionJob | undefined> {
  const rows = await getSql().query(
    `WITH candidate AS (
      SELECT job.account_id
      FROM account_deletion_job job
      WHERE (
        job.state IN ('queued', 'failed')
        OR (job.state = 'processing' AND job.next_attempt_at <= now())
      )
        AND job.next_attempt_at <= now()
        AND job.attempts < 20
      ORDER BY job.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE account_deletion_job job
      SET
        state = 'processing',
        attempts = job.attempts + 1,
        next_attempt_at = now() + interval '15 minutes',
        last_error_code = NULL
      FROM candidate
      WHERE job.account_id = candidate.account_id
      RETURNING job.account_id, job.attempts
    )
    SELECT
      claimed.account_id,
      account.auth_user_id,
      customer.stripe_customer_id,
      EXISTS (
        SELECT 1 FROM billing_subscription subscription
        WHERE subscription.account_id = claimed.account_id
          AND subscription.provider = 'app_store'
          AND subscription.apple_environment = 'Production'
          AND subscription.status IN ('trialing', 'active', 'grace', 'past_due')
          AND (
            subscription.current_period_ends_at > now()
            OR subscription.cancel_at_period_end = false
          )
      ) AS apple_subscription_active,
      claimed.attempts
    FROM claimed
    JOIN pressay_account account ON account.id = claimed.account_id
    LEFT JOIN billing_customer customer ON customer.account_id = claimed.account_id`,
    [],
  );
  const row = deletionJobSchema.safeParse(rows[0]);
  if (!row.success) return undefined;
  return {
    accountId: row.data.account_id,
    authUserId: row.data.auth_user_id,
    stripeCustomerId: row.data.stripe_customer_id,
    appleSubscriptionActive: row.data.apple_subscription_active,
    attempts: row.data.attempts,
  };
}

function isMissingStripeResource(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'resource_missing'
  );
}

async function failDeletionJob(job: DeletionJob, errorCode: string): Promise<void> {
  const delaySeconds = Math.min(3_600, 2 ** Math.min(job.attempts, 11) * 15);
  await getSql().query(
    `UPDATE account_deletion_job
    SET
      state = 'failed',
      next_attempt_at = now() + make_interval(secs => $2),
      last_error_code = $3
    WHERE account_id = $1 AND state = 'processing'`,
    [job.accountId, delaySeconds, errorCode],
  );
}

/**
 * Invitations reserved to the deleted person's address forget it. One that
 * could still be redeemed is revoked first: without its address it would
 * become redeemable by anyone holding the code. Runs before the contact row
 * is erased; replaying it changes nothing.
 */
export async function forgetReservedInvitations(accountId: string): Promise<number> {
  const rows = await getSql().query(
    `WITH contact AS (
      SELECT lower(email) AS email FROM account_contact WHERE account_id = $1
    ), forgotten AS (
      UPDATE access_campaign campaign
      SET restricted_email = NULL,
        status = CASE
          WHEN campaign.status IN ('provisioning', 'active')
            AND campaign.expires_at > now()
            AND campaign.redemptions < campaign.max_redemptions
          THEN 'revoked'
          ELSE campaign.status
        END
      FROM contact
      WHERE campaign.restricted_email = contact.email
      RETURNING 1
    )
    SELECT count(*)::integer AS forgotten FROM forgotten`,
    [accountId],
  );
  return Number(rows[0]?.forgotten ?? 0);
}

async function executeDeletionJob(job: DeletionJob): Promise<boolean> {
  if (job.stripeCustomerId) {
    try {
      await getStripe().customers.del(job.stripeCustomerId);
    } catch (error) {
      if (!isMissingStripeResource(error)) {
        await failDeletionJob(job, 'stripe_customer_deletion_failed');
        return false;
      }
    }
  }

  // Apple cannot be cancelled server-side: the user acknowledged on DELETE /me
  // that the App Store keeps billing until they cancel in their Apple settings.
  // Count it (no identifiers) so support can reconcile refund requests.
  if (job.appleSubscriptionActive) {
    writeLog('warn', 'account_deletion.apple_subscription_active', {
      outcome: 'deleted_with_acknowledgement',
    });
  }

  // Delete the web identity before the local tombstone completes, so a
  // transient web failure keeps the job retryable through the usual backoff.
  try {
    await deleteWebIdentity(job.authUserId);
  } catch (error) {
    await failDeletionJob(
      job,
      error instanceof WebIdentityDeletionError
        ? error.code
        : 'web_identity_deletion_failed',
    );
    return false;
  }

  try {
    await forgetReservedInvitations(job.accountId);
    const rows = await getSql().query(
      'SELECT complete_pressay_account_deletion($1) AS completed',
      [job.accountId],
    );
    if (rows[0]?.completed !== true) {
      await failDeletionJob(job, 'local_account_deletion_failed');
      return false;
    }
    return true;
  } catch {
    await failDeletionJob(job, 'local_account_deletion_failed');
    return false;
  }
}

/**
 * Process queued deletions until the queue is empty, `limit` jobs were claimed
 * or the deadline is near. A job is only claimed while at least `reserveMs`
 * remain, so a Stripe or web identity call (8 s timeouts) cannot overrun the
 * function's maximum duration.
 */
export async function runAccountDeletionBatch(
  limit = 10,
  options: { deadlineAt?: number; reserveMs?: number } = {},
): Promise<{ claimed: number; completed: number; failed: number; drained: boolean }> {
  const boundedLimit = Math.max(1, Math.min(limit, 1000));
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const reserveMs = options.reserveMs ?? 10_000;
  let claimed = 0;
  let completed = 0;
  let drained = false;
  while (claimed < boundedLimit && Date.now() + reserveMs <= deadlineAt) {
    const job = await claimDeletionJob();
    if (!job) {
      drained = true;
      break;
    }
    claimed += 1;
    if (await executeDeletionJob(job)) completed += 1;
  }
  return { claimed, completed, failed: claimed - completed, drained };
}
