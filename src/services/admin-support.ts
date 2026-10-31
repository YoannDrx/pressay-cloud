import type { z } from 'zod';

import { getSql } from '../db/client.js';
import { ApiError, type ApiErrorStatus } from '../lib/errors.js';
import {
  adminAuditLogSchema,
  deviceActionResultSchema,
  supportGrantResultSchema,
  type adminDeletionSchema,
  type auditQuerySchema,
  type externalAuditSchema,
  type supportActionSchema,
  type supportGrantSchema,
} from '../contracts/operations.js';
import type {
  AdminAuditLog,
  DeviceActionResult,
  ExternalAuditRecorded,
  SupportGrantResult,
} from '../contracts/operations-wire.js';
import { requestAccountDeletion } from './accounts.js';
import { likePattern } from './admin-customers.js';
import { audit, type AuditDetails } from './operations.js';

type SupportAction = z.infer<typeof supportActionSchema>;
type SupportGrant = z.infer<typeof supportGrantSchema>;
type AdminDeletion = z.infer<typeof adminDeletionSchema>;
type ExternalAudit = z.infer<typeof externalAuditSchema>;
type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Who acts, and the request that carries the action. */
export interface Operator {
  actor: string;
  requestId: string;
}

/** Errors raised by the support functions of migration 0024. */
const databaseErrors: Record<string, [ApiErrorStatus, string]> = {
  account_not_active: [409, 'The account is not active'],
  grant_not_found: [404, 'Grant not found'],
  grant_revoked: [409, 'A revoked grant cannot be extended'],
  device_not_found: [404, 'Device not found'],
  device_limit_reached: [409, 'Three devices are already active on this account'],
  invalid_duration: [422, 'Choose between 1 and 365 days'],
  request_key_reused: [409, 'This request key was already used for another target'],
};

function databaseError(error: unknown): ApiError | null {
  const message = error instanceof Error ? error.message : '';
  for (const [code, [status, text]] of Object.entries(databaseErrors))
    if (message.includes(code)) return new ApiError(status, code, text);
  return null;
}

/**
 * Audit `requested`, run the action, then audit its outcome. A refused action
 * is recorded as `failed` with its error code only.
 */
async function audited<T>(
  operator: Operator,
  action: string,
  target: string,
  reason: string,
  targetAccountId: string | null,
  run: () => Promise<{ value: T; accountId: string | null; details: AuditDetails }>,
): Promise<T> {
  await audit(
    operator.actor,
    `${action}.requested`,
    target,
    reason,
    operator.requestId,
    'requested',
    {
      targetAccountId,
    },
  );
  try {
    const outcome = await run();
    await audit(
      operator.actor,
      action,
      target,
      reason,
      operator.requestId,
      outcome.details.replayed === true ? 'replayed' : 'succeeded',
      {
        targetAccountId: outcome.accountId ?? targetAccountId,
        details: outcome.details,
      },
    );
    return outcome.value;
  } catch (error) {
    const mapped = error instanceof ApiError ? error : databaseError(error);
    await audit(operator.actor, action, target, reason, operator.requestId, 'failed', {
      targetAccountId,
      details: { errorCode: mapped?.code ?? 'internal_error' },
    });
    throw mapped ?? error;
  }
}

function refuseSelf(operator: Operator, accountId: string): void {
  if (operator.actor === accountId)
    throw new ApiError(
      409,
      'cannot_target_self',
      'Use your own account settings for your account',
    );
}

/** Offer Pro for `days` days from now, then recompute the entitlement. */
export async function offerSupportAccess(
  operator: Operator,
  accountId: string,
  input: SupportGrant,
): Promise<SupportGrantResult> {
  return audited(
    operator,
    'grant.create',
    accountId,
    input.reason,
    accountId,
    async () => {
      const rows = await getSql().query(
        'SELECT grant_pressay_support_access($1,$2,$3,$4,$5) AS result',
        [accountId, input.days, input.reason, operator.actor, input.idempotencyKey],
      );
      const value = supportGrantResultSchema.parse(rows[0]?.result);
      return {
        value,
        accountId: value.accountId,
        details: {
          grantId: value.grantId,
          days: value.days,
          endsAt: value.endsAt,
          replayed: value.replayed,
        },
      };
    },
  );
}

/** Extend a grant by `days` from its end (or from now when it has ended). */
export async function extendGrant(
  operator: Operator,
  grantId: string,
  input: SupportGrant,
): Promise<SupportGrantResult> {
  const owner = await getSql().query(
    'SELECT account_id FROM access_grant WHERE id=$1',
    [grantId],
  );
  const accountId = owner[0] ? String(owner[0].account_id) : null;
  return audited(
    operator,
    'grant.extend',
    grantId,
    input.reason,
    accountId,
    async () => {
      const rows = await getSql().query(
        'SELECT extend_pressay_grant($1,$2,$3) AS result',
        [grantId, input.days, input.idempotencyKey],
      );
      const value = supportGrantResultSchema.parse(rows[0]?.result);
      return {
        value,
        accountId: value.accountId,
        details: { days: value.days, endsAt: value.endsAt, replayed: value.replayed },
      };
    },
  );
}

/** Revoke a grant (any origin) and recompute the entitlement. */
export async function revokeGrant(
  operator: Operator,
  grantId: string,
  input: { reason: string },
): Promise<void> {
  const owner = await getSql().query(
    'SELECT account_id FROM access_grant WHERE id=$1',
    [grantId],
  );
  const accountId = owner[0] ? String(owner[0].account_id) : null;
  await audited(
    operator,
    'grant.revoke',
    grantId,
    input.reason,
    accountId,
    async () => {
      const rows = await getSql().query('SELECT revoke_pressay_grant($1) AS revoked', [
        grantId,
      ]);
      if (!rows[0]?.revoked)
        throw new ApiError(404, 'grant_not_found', 'Grant not found');
      return { value: undefined, accountId, details: {} };
    },
  );
}

/** Revoke a device's Cloud access. Revoking twice keeps the first date. */
export async function revokeDeviceAsSupport(
  operator: Operator,
  deviceId: string,
  input: SupportAction,
): Promise<DeviceActionResult> {
  const owner = await getSql().query(
    'SELECT account_id FROM pressay_device WHERE id=$1',
    [deviceId],
  );
  const accountId = owner[0] ? String(owner[0].account_id) : null;
  return audited(
    operator,
    'device.revoke',
    deviceId,
    input.reason,
    accountId,
    async () => {
      const rows = await getSql().query(
        `WITH previous AS (SELECT revoked_at FROM pressay_device WHERE id=$1)
      UPDATE pressay_device d SET revoked_at=COALESCE(d.revoked_at,now())
      FROM previous WHERE d.id=$1
      RETURNING d.account_id,d.platform,previous.revoked_at IS NULL AS changed`,
        [deviceId],
      );
      if (!rows[0]) throw new ApiError(404, 'device_not_found', 'Device not found');
      const row = rows[0] as Record<string, unknown>;
      const value = deviceActionResultSchema.parse({
        deviceId,
        accountId: row.account_id,
        platform: row.platform,
        changed: row.changed,
      });
      return {
        value,
        accountId: value.accountId,
        details: { platform: value.platform, changed: value.changed },
      };
    },
  );
}

/** Lift a revocation, within the account's three active devices. */
export async function restoreDeviceAsSupport(
  operator: Operator,
  deviceId: string,
  input: SupportAction,
): Promise<DeviceActionResult> {
  const owner = await getSql().query(
    'SELECT account_id FROM pressay_device WHERE id=$1',
    [deviceId],
  );
  const accountId = owner[0] ? String(owner[0].account_id) : null;
  return audited(
    operator,
    'device.restore',
    deviceId,
    input.reason,
    accountId,
    async () => {
      const rows = await getSql().query(
        'SELECT restore_pressay_device($1,NULL,$2) AS result',
        [deviceId, input.idempotencyKey],
      );
      const result = rows[0]?.result as Record<string, unknown> | undefined;
      const value = deviceActionResultSchema.parse({
        ...result,
        changed: result?.restored,
      });
      return {
        value,
        accountId: value.accountId,
        details: {
          platform: value.platform,
          changed: value.changed,
          replayed: value.replayed,
        },
      };
    },
  );
}

/** Restore one of the signed-in user's own revoked devices. */
export async function restoreOwnDevice(authUserId: string, deviceId: string) {
  try {
    const rows = await getSql().query(
      'SELECT restore_pressay_device($1,$2,NULL) AS result',
      [deviceId, authUserId],
    );
    const result = rows[0]?.result as Record<string, unknown> | undefined;
    return { restored: result?.restored === true };
  } catch (error) {
    throw databaseError(error) ?? error;
  }
}

async function subjectOf(accountId: string) {
  const rows = await getSql().query(
    'SELECT auth_user_id,status FROM pressay_account WHERE id=$1',
    [accountId],
  );
  if (!rows[0]) throw new ApiError(404, 'account_not_found', 'Account not found');
  return { authUserId: String(rows[0].auth_user_id), status: String(rows[0].status) };
}

/**
 * Queue the account's deletion like DELETE /v1/me does: devices are revoked
 * at once, the worker then erases Cloud data, the Stripe customer and the
 * web identity. An active App Store subscription must be acknowledged.
 */
export async function requestDeletionAsSupport(
  operator: Operator,
  accountId: string,
  input: AdminDeletion,
): Promise<{ status: 'deleting' }> {
  refuseSelf(operator, accountId);
  return audited(
    operator,
    'account.deletion',
    accountId,
    input.reason,
    accountId,
    async () => {
      const account = await subjectOf(accountId);
      if (account.status === 'deleted')
        throw new ApiError(409, 'account_deleted', 'The account is already deleted');
      await requestAccountDeletion(account.authUserId, {
        acknowledgeAppleSubscription: input.acknowledgeAppleSubscription,
      });
      return {
        value: { status: 'deleting' as const },
        accountId,
        details: {
          previousStatus: account.status,
          appleAcknowledged: input.acknowledgeAppleSubscription,
        },
      };
    },
  );
}

/**
 * Record an action the web performs on its own database (sessions and OAuth
 * tokens live there). The `requested` entry returns the identity subject the
 * web acts on, so the web never chooses it itself.
 */
export async function recordExternalAction(
  operator: Operator,
  input: ExternalAudit,
): Promise<ExternalAuditRecorded> {
  refuseSelf(operator, input.targetAccountId);
  const account = await subjectOf(input.targetAccountId);
  const action = `external.${input.action}.${input.result}`;
  const rows = await getSql().query(
    `INSERT INTO operations_request(request_key,action,target_id) VALUES($1,$2,$3)
    ON CONFLICT DO NOTHING RETURNING target_id`,
    [input.idempotencyKey, action, input.targetAccountId],
  );
  if (rows.length)
    await audit(
      operator.actor,
      input.action,
      input.targetAccountId,
      input.reason,
      operator.requestId,
      input.result,
      {
        targetAccountId: input.targetAccountId,
        details: Object.fromEntries(
          Object.entries(input.details).filter(([, value]) => value !== undefined),
        ) as AuditDetails,
      },
    );
  return { recorded: true, authUserId: account.authUserId };
}

/**
 * Audit ledger, newest first, 50 entries per page. Filters: action (exact or
 * dotted prefix), target (account id or exact target id), UTC day range and
 * whether personal-data reads are listed.
 */
export async function auditLog(query: AuditQuery): Promise<AdminAuditLog> {
  const target = query.target;
  const targetAccount =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)
      ? target.toLowerCase()
      : null;
  const rows = await getSql().query(
    `SELECT o.id::text AS id,o.actor_id,c.email AS actor_email,o.action,o.target_id,
      o.target_account_id,o.reason,o.result,o.request_id,o.details,o.created_at
    FROM operations_audit o
    LEFT JOIN account_contact c ON c.account_id=o.actor_id
    WHERE ($1='' OR o.action=$1 OR o.action LIKE $2||'.%')
      AND ($3='' OR o.target_id=$3 OR o.target_account_id=$4::uuid)
      AND ($5::date IS NULL OR o.created_at>=$5::date::timestamp AT TIME ZONE 'UTC')
      AND ($6::date IS NULL OR o.created_at<($6::date+1)::timestamp AT TIME ZONE 'UTC')
      AND ($7='include' OR o.reason<>'personal_data_read')
      AND ($8::bigint IS NULL OR o.id<$8::bigint)
    ORDER BY o.id DESC LIMIT 51`,
    [
      query.action,
      likePattern(query.action),
      target,
      targetAccount,
      query.from ?? null,
      query.to ?? null,
      query.reads,
      query.cursor ?? null,
    ],
  );
  return adminAuditLogSchema.parse({
    entries: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? String(rows[49]?.id) : null,
  });
}
