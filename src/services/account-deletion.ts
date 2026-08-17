import { z } from 'zod';

import { getStripe } from '../billing/stripe-client.ts';
import { getSql } from '../db/client.ts';

const deletionJobSchema = z.object({
  account_id: z.uuid(),
  auth_user_id: z.string(),
  stripe_customer_id: z.string().nullable(),
  attempts: z.coerce.number().int().min(1).max(20),
});

interface DeletionJob {
  accountId: string;
  authUserId: string;
  stripeCustomerId: string | null;
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

  try {
    const rows = await getSql().query(
      `DELETE FROM "user" auth_user
      USING pressay_account account, account_deletion_job job
      WHERE auth_user.id = $1
        AND account.auth_user_id = auth_user.id
        AND job.account_id = account.id
        AND job.state = 'processing'
      RETURNING auth_user.id`,
      [job.authUserId],
    );
    if (rows.length === 0) {
      await failDeletionJob(job, 'local_account_deletion_failed');
      return false;
    }
    return true;
  } catch {
    await failDeletionJob(job, 'local_account_deletion_failed');
    return false;
  }
}

export async function runAccountDeletionBatch(
  limit = 10,
): Promise<{ claimed: number; completed: number; failed: number }> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  let claimed = 0;
  let completed = 0;
  for (let index = 0; index < boundedLimit; index += 1) {
    const job = await claimDeletionJob();
    if (!job) break;
    claimed += 1;
    if (await executeDeletionJob(job)) completed += 1;
  }
  return { claimed, completed, failed: claimed - completed };
}
