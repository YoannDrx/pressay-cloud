import type { z } from 'zod';

import { getSql } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import {
  adminUserDetailSchema,
  adminUsersSchema,
  type AdminUserSearchKind,
  type userQuerySchema,
} from '../contracts/operations.js';
import type { AdminUserDetail, AdminUsers } from '../contracts/operations-wire.js';
import { effectiveEntitlement } from './entitlements.js';

type UserQuery = z.infer<typeof userQuerySchema>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Support pastes whatever identifier the customer or a provider shows. The
 * format decides which indexed column is searched, so an identifier never
 * falls back to a substring scan of email addresses.
 */
export function classifySearch(search: string): AdminUserSearchKind {
  const value = search.trim();
  if (!value) return 'none';
  if (/^cus_[A-Za-z0-9]+$/.test(value)) return 'stripe_customer';
  if (/^sub_[A-Za-z0-9]+$/.test(value)) return 'stripe_subscription';
  // App Store original transaction identifiers are decimal strings.
  if (/^\d{8,25}$/.test(value)) return 'apple_transaction';
  if (UUID.test(value)) return 'uuid';
  return 'text';
}

/** ILIKE treats `%`, `_` and the escape character as wildcards. */
export function likePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const identifierLookups: Record<
  Exclude<AdminUserSearchKind, 'none' | 'text'>,
  string
> = {
  // Account, device or identity-provider subject.
  uuid: `SELECT id FROM pressay_account WHERE id=$1::text::uuid OR auth_user_id=$1::text
    UNION SELECT account_id FROM pressay_device WHERE id=$1::text::uuid`,
  stripe_customer:
    'SELECT account_id AS id FROM billing_customer WHERE stripe_customer_id=$1',
  stripe_subscription:
    "SELECT account_id AS id FROM billing_subscription WHERE provider='stripe' AND provider_subscription_id=$1",
  // Sandbox subscriptions are namespaced with a `sandbox/` prefix.
  apple_transaction: `SELECT account_id AS id FROM billing_customer WHERE app_store_original_transaction_id=$1
    UNION SELECT account_id FROM billing_subscription
    WHERE provider='app_store' AND provider_subscription_id IN ($1,'sandbox/'||$1)`,
};

const PLAN = `CASE WHEN e.tier='pro' AND e.valid_until>now()
  THEN CASE WHEN e.sandbox THEN 'sandbox' ELSE 'pro' END ELSE 'free' END`;

export async function searchAccounts(query: UserQuery): Promise<AdminUsers> {
  const kind = classifySearch(query.search);
  const search = query.search.trim();
  let ids: string[] | null = null;
  if (kind !== 'none' && kind !== 'text') {
    const rows = await getSql().query(identifierLookups[kind], [search]);
    ids = rows.map((row) => String(row.id));
  }
  const rows = await getSql().query(
    `SELECT a.id,u.email,u.email AS display_name,a.status,a.created_at,
    ${PLAN} AS plan,
    COALESCE(e.source,'none') AS entitlement_source,
    COALESCE(e.sandbox,false) AS sandbox,
    COALESCE(d.macos,0) AS macos_device_count,
    COALESCE(d.windows,0) AS windows_device_count,
    COALESCE(d.macos,0)+COALESCE(d.windows,0) AS active_device_count,
    d.last_seen AS last_device_seen_at
    FROM pressay_account a
    LEFT JOIN account_contact u ON u.account_id=a.id
    LEFT JOIN entitlement e ON e.account_id=a.id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE revoked_at IS NULL AND platform='macos')::int AS macos,
        count(*) FILTER (WHERE revoked_at IS NULL AND platform='windows')::int AS windows,
        max(last_seen_at) AS last_seen
      FROM pressay_device WHERE account_id=a.id
    ) d ON true
    WHERE ($1::uuid[] IS NULL OR a.id=ANY($1::uuid[]))
      AND ($2='' OR u.email ILIKE '%'||$2||'%' OR a.auth_user_id=$3)
      AND ($4='' OR ${PLAN}=$4)
      AND ($5='' OR a.status=$5) AND ($6::uuid IS NULL OR a.id>$6::uuid)
    ORDER BY a.id LIMIT 51`,
    [
      ids,
      kind === 'text' ? likePattern(search) : '',
      kind === 'text' ? search : '',
      query.plan,
      query.status,
      query.cursor ?? null,
    ],
  );
  return adminUsersSchema.parse({
    users: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? String(rows[49]?.id) : null,
    searchKind: kind,
  });
}

const iso = (value: unknown) =>
  value ? new Date(value as string).toISOString() : null;

/**
 * Everything support needs about one Cloud account. Identity data (linked
 * providers, passkeys, sessions) lives in the web database and is read there.
 * Raw provider payloads, payment instruments and sync content are never read.
 */
export async function customerDetail(
  id: string,
  stripeMode: 'live' | 'test',
): Promise<AdminUserDetail> {
  const sql = getSql();
  const rows = await sql.query(
    `SELECT a.id,a.auth_user_id,a.status,a.created_at,a.deletion_requested_at,u.email,
      e.tier,e.source,e.valid_from,e.valid_until,e.offline_grace_until,e.revision,e.sandbox,
      c.stripe_customer_id,c.app_store_original_transaction_id
    FROM pressay_account a
    LEFT JOIN account_contact u ON u.account_id=a.id
    LEFT JOIN entitlement e ON e.account_id=a.id
    LEFT JOIN billing_customer c ON c.account_id=a.id
    WHERE a.id=$1`,
    [id],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError(404, 'account_not_found', 'Account not found');
  const [
    usage,
    devices,
    subscriptions,
    financialEvents,
    legalAcceptances,
    deletion,
    grants,
    referrals,
  ] = await Promise.all([
    sql.query(
      `SELECT to_char(p.period_start,'YYYY-MM-DD') AS period_start,
        p.transcription_seconds_used,p.transformations_used
      FROM usage_period p WHERE p.account_id=$1
        AND p.period_start>=(date_trunc('month',now())-interval '11 months')::date
      ORDER BY p.period_start DESC`,
      [id],
    ),
    sql.query(
      `SELECT id,display_name,platform,app_variant,app_version,approved_at IS NOT NULL AS approved,
        last_seen_at,created_at,revoked_at
      FROM pressay_device WHERE account_id=$1
      ORDER BY revoked_at IS NOT NULL,last_seen_at DESC`,
      [id],
    ),
    sql.query(
      `SELECT provider,provider_subscription_id,provider_product_id,status,billing_interval,
        trial_ends_at,current_period_starts_at,current_period_ends_at,cancel_at_period_end,
        grace_ends_at,apple_environment,created_at,updated_at
      FROM billing_subscription WHERE account_id=$1
      ORDER BY provider_event_occurred_at DESC`,
      [id],
    ),
    sql.query(
      `SELECT provider_event_id,provider_object_id,provider_subscription_id,kind,status,
        amount_minor,currency,full_reversal,provider_occurred_at
      FROM billing_financial_event WHERE account_id=$1
      ORDER BY provider_occurred_at DESC LIMIT 50`,
      [id],
    ),
    sql.query(
      `SELECT terms_version,immediate_performance_consent,accepted_at
      FROM billing_legal_acceptance WHERE account_id=$1
      ORDER BY accepted_at DESC LIMIT 50`,
      [id],
    ),
    sql.query(
      `SELECT state,attempts,next_attempt_at,last_error_code,created_at,completed_at
      FROM account_deletion_job WHERE account_id=$1`,
      [id],
    ),
    sql.query(
      'SELECT id,source,starts_at,ends_at,revoked_at,reason,created_by FROM access_grant WHERE account_id=$1 ORDER BY created_at DESC',
      [id],
    ),
    sql.query(
      'SELECT id,referrer_id,referee_id,status,attributed_at FROM referral_attribution WHERE referrer_id=$1 OR referee_id=$1',
      [id],
    ),
  ]);
  // Entries name their account since migration 0024; older ones target the
  // account or one of its grants by id as text. Reads are counted, not
  // listed, to keep actions visible.
  const targets = [id, ...grants.map((grant) => String(grant.id))];
  const [audit, reads] = await Promise.all([
    sql.query(
      `SELECT id::text AS id,actor_id,action,target_id,target_account_id,reason,result,
        request_id,details,created_at
      FROM operations_audit
      WHERE (target_id=ANY($1::text[]) OR target_account_id=$2::uuid)
        AND reason<>'personal_data_read'
      ORDER BY id DESC LIMIT 50`,
      [targets, id],
    ),
    sql.query(
      `SELECT count(*)::int AS count,max(created_at) AS last_at
      FROM operations_audit WHERE target_id=$1 AND reason='personal_data_read'`,
      [id],
    ),
  ]);
  const entitlement = effectiveEntitlement({
    tier: row.tier === 'pro' ? 'pro' : 'free',
    source: (row.source ?? 'none') as 'none',
    validFrom: iso(row.valid_from) ?? iso(row.created_at) ?? new Date(0).toISOString(),
    validUntil: iso(row.valid_until),
    offlineGraceUntil: iso(row.offline_grace_until),
    revision: Number(row.revision ?? 1),
  });
  const current = usage[0] as Record<string, unknown> | undefined;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const thisMonth = current && String(current.period_start).startsWith(currentMonth);
  return adminUserDetailSchema.parse({
    account: {
      accountId: row.id,
      authUserId: row.auth_user_id,
      email: row.email ?? null,
      status: row.status,
      createdAt: row.created_at,
      deletionRequestedAt: row.deletion_requested_at,
      entitlement: {
        ...entitlement,
        sandbox: entitlement.tier === 'pro' && row.sandbox === true,
      },
    },
    billingCustomer: {
      stripeCustomerId: row.stripe_customer_id ?? null,
      appStoreOriginalTransactionId: row.app_store_original_transaction_id ?? null,
      stripeMode,
    },
    usage: {
      transcription: {
        usedSeconds: thisMonth ? Number(current.transcription_seconds_used) : 0,
      },
      transformations: { used: thisMonth ? Number(current.transformations_used) : 0 },
    },
    usageHistory: usage,
    devices: devices.map((device: Record<string, unknown>) => ({
      id: device.id,
      displayName: device.display_name,
      platform: device.platform,
      appVariant: device.app_variant,
      appVersion: device.app_version,
      approved: device.approved,
      lastSeenAt: device.last_seen_at,
      createdAt: device.created_at,
      revokedAt: device.revoked_at,
    })),
    subscriptions,
    financialEvents,
    legalAcceptances,
    deletion: deletion[0] ?? null,
    grants,
    referrals,
    audit,
    auditReads: {
      count: Number(reads[0]?.count ?? 0),
      lastAt: (reads[0]?.last_at as unknown) ?? null,
    },
  });
}
