import { z } from 'zod';

import { getSql } from '../db/client.js';
import { ApiError } from '../lib/errors.js';

/**
 * Machine-readable copy of the personal data Cloud holds for the caller
 * (GDPR art. 15 and 20). Hashes, keys, encrypted payloads and provider
 * identifiers are omitted: they are not readable data about the person and
 * some are security material. Sync content is end-to-end encrypted, so only
 * its volume is reported; the desktop app holds the readable copy.
 */
export async function exportAccountData(
  authUserId: string,
): Promise<Record<string, unknown>> {
  const rows = await getSql().query(
    `SELECT json_build_object(
      'format', 'pressay-cloud-export/1',
      'generatedAt', now(),
      'account', json_build_object(
        'id', account.id,
        'status', account.status,
        'createdAt', account.created_at
      ),
      'contact', (
        SELECT json_build_object('email', contact.email, 'verifiedAt', contact.verified_at)
        FROM account_contact contact WHERE contact.account_id = account.id
      ),
      'entitlement', (
        SELECT json_build_object(
          'tier', entitlement.tier,
          'source', entitlement.source,
          'validFrom', entitlement.valid_from,
          'validUntil', entitlement.valid_until,
          'offlineGraceUntil', entitlement.offline_grace_until
        )
        FROM entitlement WHERE entitlement.account_id = account.id
      ),
      'devices', COALESCE((
        SELECT json_agg(json_build_object(
          'id', device.id,
          'displayName', device.display_name,
          'platform', device.platform,
          'appVariant', device.app_variant,
          'appVersion', device.app_version,
          'approvedAt', device.approved_at,
          'lastSeenAt', device.last_seen_at,
          'revokedAt', device.revoked_at,
          'createdAt', device.created_at
        ) ORDER BY device.created_at)
        FROM pressay_device device WHERE device.account_id = account.id
      ), '[]'::json),
      'subscriptions', COALESCE((
        SELECT json_agg(json_build_object(
          'provider', subscription.provider,
          'status', subscription.status,
          'interval', subscription.billing_interval,
          'environment', subscription.apple_environment,
          'currentPeriodStartsAt', subscription.current_period_starts_at,
          'currentPeriodEndsAt', subscription.current_period_ends_at,
          'cancelAtPeriodEnd', subscription.cancel_at_period_end,
          'createdAt', subscription.created_at
        ) ORDER BY subscription.created_at)
        FROM billing_subscription subscription WHERE subscription.account_id = account.id
      ), '[]'::json),
      'payments', COALESCE((
        SELECT json_agg(json_build_object(
          'kind', financial.kind,
          'status', financial.status,
          'amountMinor', financial.amount_minor,
          'currency', financial.currency,
          'occurredAt', financial.provider_occurred_at
        ) ORDER BY financial.provider_occurred_at)
        FROM billing_financial_event financial WHERE financial.account_id = account.id
      ), '[]'::json),
      'legalAcceptances', COALESCE((
        SELECT json_agg(json_build_object(
          'termsVersion', acceptance.terms_version,
          'immediatePerformanceConsent', acceptance.immediate_performance_consent,
          'acceptedAt', acceptance.accepted_at
        ) ORDER BY acceptance.accepted_at)
        FROM billing_legal_acceptance acceptance WHERE acceptance.account_id = account.id
      ), '[]'::json),
      'usage', COALESCE((
        SELECT json_agg(json_build_object(
          'periodStart', usage.period_start,
          'transcriptionSecondsUsed', usage.transcription_seconds_used,
          'transformationsUsed', usage.transformations_used
        ) ORDER BY usage.period_start)
        FROM usage_period usage WHERE usage.account_id = account.id
      ), '[]'::json),
      'accessGrants', COALESCE((
        SELECT json_agg(json_build_object(
          'source', grant_row.source,
          'startsAt', grant_row.starts_at,
          'endsAt', grant_row.ends_at,
          'revokedAt', grant_row.revoked_at
        ) ORDER BY grant_row.starts_at)
        FROM access_grant grant_row WHERE grant_row.account_id = account.id
      ), '[]'::json),
      'referral', json_build_object(
        'code', (SELECT code FROM referral_code WHERE account_id = account.id),
        'referredBy', (
          SELECT json_build_object('attributedAt', attributed_at, 'status', status)
          FROM referral_attribution WHERE referee_id = account.id
        ),
        'referralsMade', (
          SELECT count(*)::integer FROM referral_attribution WHERE referrer_id = account.id
        )
      ),
      'encryptedSyncChanges', (
        SELECT count(*)::integer FROM sync_change WHERE account_id = account.id
      )
    ) AS export
    FROM pressay_account account
    WHERE account.auth_user_id = $1 AND account.status = 'active'`,
    [authUserId],
  );
  const parsed = z
    .object({ export: z.record(z.string(), z.unknown()) })
    .safeParse(rows[0]);
  if (!parsed.success)
    throw new ApiError(404, 'account_not_found', 'Account not found');
  return parsed.data.export;
}
