import type { z } from 'zod';

import { getSql } from '../db/client.js';
import { ApiError, type ApiErrorStatus } from '../lib/errors.js';
import {
  adminMembersSchema,
  memberChangeResultSchema,
  type supportActionSchema,
} from '../contracts/operations.js';
import type {
  AdminMembers,
  MemberChangeResult,
  OperationsRole,
} from '../contracts/operations-wire.js';
import { audited, type Operator } from './admin-support.js';
import { alertMemberChange } from './ops-alert.js';

type SupportAction = z.infer<typeof supportActionSchema>;

/** Administrators with their address, role and who added them. */
export async function listMembers(): Promise<AdminMembers> {
  const rows = await getSql().query(
    `SELECT member.account_id AS "accountId", account.auth_user_id AS "authUserId",
      contact.email, member.role, member.added_by AS "addedBy",
      adder.email AS "addedByEmail", member.created_at AS "createdAt",
      member.updated_at AS "updatedAt"
    FROM operations_member member
    JOIN pressay_account account ON account.id = member.account_id
    LEFT JOIN account_contact contact ON contact.account_id = member.account_id
    LEFT JOIN account_contact adder ON adder.account_id = member.added_by
    WHERE account.status = 'active'
    ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'support' THEN 1 ELSE 2 END,
      member.created_at`,
    [],
  );
  return adminMembersSchema.parse({ members: rows });
}

/** The active account behind a verified address, or 404. */
export async function accountByEmail(email: string): Promise<string> {
  const rows = await getSql().query(
    `SELECT account.id FROM account_contact contact
    JOIN pressay_account account ON account.id = contact.account_id
    WHERE lower(contact.email) = $1 AND account.status = 'active'
    LIMIT 2`,
    [email.toLowerCase()],
  );
  if (rows.length !== 1)
    throw new ApiError(
      404,
      'account_not_found',
      'No single active account uses this verified address; ask the person to sign in once',
    );
  return String(rows[0]?.id);
}

const memberErrors: Record<string, [ApiErrorStatus, string]> = {
  owner_required: [403, 'Only an owner manages administrators'],
  last_owner: [409, 'Keep at least one active owner'],
  member_not_found: [404, 'Not an administrator'],
  account_not_active: [409, 'The account is not active'],
  invalid_role: [422, 'Choose owner, support or readonly'],
  request_key_reused: [409, 'This request key was already used for another target'],
};

/**
 * Add, change (`role`) or remove (`role` null) an administrator, audited as
 * `member.role.set` or `member.remove` with the previous and new role, and
 * announced to OPS_ALERT_WEBHOOK_URL when it changed something.
 */
export async function setMember(
  operator: Operator,
  accountId: string,
  role: OperationsRole | null,
  input: SupportAction,
): Promise<MemberChangeResult> {
  const result = await audited(
    operator,
    role ? 'member.role.set' : 'member.remove',
    accountId,
    input.reason,
    accountId,
    async () => {
      let rows: Record<string, unknown>[];
      try {
        rows = await getSql().query(
          'SELECT set_pressay_operations_member($1,$2,$3,$4) AS result',
          [operator.actor, accountId, role, input.idempotencyKey],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        for (const [code, [status, text]] of Object.entries(memberErrors))
          if (message.includes(code)) throw new ApiError(status, code, text);
        throw error;
      }
      const value = memberChangeResultSchema.parse(rows[0]?.result);
      return {
        value,
        accountId: value.accountId,
        details: {
          role: value.role,
          previousRole: value.previousRole,
          changed: value.changed,
          replayed: value.replayed,
        },
      };
    },
  );
  if (result.changed && !result.replayed)
    await alertMemberChange({
      event: 'operations_member.changed',
      accountId: result.accountId,
      actorAccountId: operator.actor,
      previousRole: result.previousRole,
      role: result.role,
      requestId: operator.requestId,
    });
  return result;
}
