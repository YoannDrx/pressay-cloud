import { createHmac } from 'node:crypto';

import { z } from 'zod';

import type {
  BootstrapAccountRequest,
  Device,
  Entitlement,
  UsageSnapshot,
} from '../contracts/account.ts';
import {
  deviceListResponseSchema,
  entitlementSchema,
  meResponseSchema,
  usageSnapshotSchema,
} from '../contracts/account.ts';
import { getSql } from '../db/client.ts';
import { getEnvironment, requireEnvironmentValue } from '../env.ts';
import { ApiError } from '../lib/errors.ts';

const bootstrapRowSchema = z.object({
  account_id: z.uuid(),
  account_created: z.boolean(),
  device_id: z.uuid(),
  entitlement_tier: z.enum(['free', 'pro']),
  entitlement_source: z.enum(['none', 'trial', 'stripe', 'app_store', 'support']),
  entitlement_valid_from: z.coerce.date(),
  entitlement_valid_until: z.coerce.date().nullable(),
  entitlement_offline_grace_until: z.coerce.date().nullable(),
  entitlement_revision: z.coerce.number().int().positive(),
});

const deviceRowSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  app_variant: z.enum(['direct', 'mas']),
  app_version: z.string(),
  approved: z.boolean(),
  last_seen_at: z.coerce.date(),
  created_at: z.coerce.date(),
});

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function deviceIdentifierHash(identifier: string): string {
  const environment = getEnvironment();
  return createHmac(
    'sha256',
    requireEnvironmentValue(
      environment.DEVICE_IDENTIFIER_HMAC_SECRET,
      'DEVICE_IDENTIFIER_HMAC_SECRET',
    ),
  )
    .update(identifier)
    .digest('hex');
}

function mapDatabaseConflict(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('device_limit_reached')) {
    throw new ApiError(
      409,
      'device_limit_reached',
      'Three Cloud devices are already active',
    );
  }
  if (message.includes('device_revoked')) {
    throw new ApiError(403, 'device_revoked', 'This device has been revoked');
  }
  if (message.includes('account_not_active')) {
    throw new ApiError(403, 'account_not_active', 'This account is not active');
  }
  throw error;
}

function mapEntitlement(row: {
  entitlement_tier: Entitlement['tier'];
  entitlement_source: Entitlement['source'];
  entitlement_valid_from: Date;
  entitlement_valid_until: Date | null;
  entitlement_offline_grace_until: Date | null;
  entitlement_revision: number;
}): Entitlement {
  return entitlementSchema.parse({
    tier: row.entitlement_tier,
    source: row.entitlement_source,
    validFrom: iso(row.entitlement_valid_from),
    validUntil: nullableIso(row.entitlement_valid_until),
    offlineGraceUntil: nullableIso(row.entitlement_offline_grace_until),
    revision: row.entitlement_revision,
  });
}

export async function bootstrapAccount(
  authUserId: string,
  input: BootstrapAccountRequest,
): Promise<{
  accountId: string;
  created: boolean;
  deviceId: string;
  entitlement: Entitlement;
}> {
  try {
    const rows = await getSql().query(
      `SELECT
        result_account_id AS account_id,
        result_account_created AS account_created,
        result_device_id AS device_id,
        result_entitlement_tier AS entitlement_tier,
        result_entitlement_source AS entitlement_source,
        result_entitlement_valid_from AS entitlement_valid_from,
        result_entitlement_valid_until AS entitlement_valid_until,
        result_entitlement_offline_grace_until AS entitlement_offline_grace_until,
        result_entitlement_revision AS entitlement_revision
      FROM bootstrap_pressay_account($1, decode($2, 'hex'), $3, $4, $5)`,
      [
        authUserId,
        deviceIdentifierHash(input.deviceIdentifier),
        input.displayName,
        input.appVariant,
        input.appVersion,
      ],
    );
    const row = bootstrapRowSchema.parse(rows[0]);
    return {
      accountId: row.account_id,
      created: row.account_created,
      deviceId: row.device_id,
      entitlement: mapEntitlement(row),
    };
  } catch (error) {
    return mapDatabaseConflict(error);
  }
}

export async function getMe(authUserId: string, email: string) {
  const rows = await getSql().query(
    `SELECT
      a.id AS account_id,
      a.status,
      a.created_at,
      e.tier,
      e.source,
      e.valid_from,
      e.valid_until,
      e.offline_grace_until,
      e.revision
    FROM pressay_account a
    JOIN entitlement e ON e.account_id = a.id
    WHERE a.auth_user_id = $1`,
    [authUserId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError(404, 'account_not_found', 'Account not found');
  return meResponseSchema.parse({
    accountId: row.account_id,
    email,
    status: row.status,
    createdAt: iso(row.created_at as string),
    entitlement: {
      tier: row.tier,
      source: row.source,
      validFrom: iso(row.valid_from as string),
      validUntil: nullableIso(row.valid_until as string | null),
      offlineGraceUntil: nullableIso(row.offline_grace_until as string | null),
      revision: Number(row.revision),
    },
  });
}

export async function listDevices(authUserId: string): Promise<readonly Device[]> {
  const rows = await getSql().query(
    `SELECT
      d.id,
      d.display_name,
      d.app_variant,
      d.app_version,
      d.approved_at IS NOT NULL AS approved,
      d.last_seen_at,
      d.created_at
    FROM pressay_device d
    JOIN pressay_account a ON a.id = d.account_id
    WHERE a.auth_user_id = $1 AND d.revoked_at IS NULL
    ORDER BY d.last_seen_at DESC`,
    [authUserId],
  );
  return deviceListResponseSchema.parse({
    devices: rows.map((unparsedRow) => {
      const row = deviceRowSchema.parse(unparsedRow);
      return {
        id: row.id,
        displayName: row.display_name,
        appVariant: row.app_variant,
        appVersion: row.app_version,
        approved: row.approved,
        lastSeenAt: iso(row.last_seen_at),
        createdAt: iso(row.created_at),
      };
    }),
    limit: 3,
  }).devices;
}

export async function revokeDevice(
  authUserId: string,
  deviceId: string,
): Promise<void> {
  const rows = await getSql().query(
    `UPDATE pressay_device d
    SET revoked_at = COALESCE(d.revoked_at, now())
    FROM pressay_account a
    WHERE d.id = $1 AND d.account_id = a.id AND a.auth_user_id = $2
    RETURNING d.id`,
    [deviceId, authUserId],
  );
  if (rows.length === 0)
    throw new ApiError(404, 'device_not_found', 'Device not found');
}

export async function assertActiveDevice(
  authUserId: string,
  deviceId: string,
): Promise<void> {
  const rows = await getSql().query(
    `SELECT d.id
    FROM pressay_device d
    JOIN pressay_account a ON a.id = d.account_id
    WHERE d.id = $1 AND a.auth_user_id = $2 AND d.revoked_at IS NULL`,
    [deviceId, authUserId],
  );
  if (rows.length === 0)
    throw new ApiError(403, 'device_not_active', 'Device is not active');
}

export async function getUsage(authUserId: string): Promise<UsageSnapshot> {
  const rows = await getSql().query(
    `SELECT
      date_trunc('month', now())::date AS period_start,
      COALESCE(u.transcription_seconds_used, 0) AS transcription_seconds_used,
      COALESCE(u.transcription_seconds_reserved, 0) AS transcription_seconds_reserved,
      COALESCE(u.transformations_used, 0) AS transformations_used,
      COALESCE(u.transformations_reserved, 0) AS transformations_reserved,
      limits.cloud_transcription_seconds,
      limits.cloud_transformations
    FROM pressay_account a
    JOIN entitlement e ON e.account_id = a.id
    JOIN plan_limit limits ON limits.tier = e.tier
    LEFT JOIN usage_period u
      ON u.account_id = a.id
      AND u.period_start = date_trunc('month', now())::date
    WHERE a.auth_user_id = $1`,
    [authUserId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError(404, 'account_not_found', 'Account not found');
  return usageSnapshotSchema.parse({
    periodStart: String(row.period_start),
    transcription: {
      usedSeconds: Number(row.transcription_seconds_used),
      reservedSeconds: Number(row.transcription_seconds_reserved),
      limitSeconds: Number(row.cloud_transcription_seconds),
    },
    transformations: {
      used: Number(row.transformations_used),
      reserved: Number(row.transformations_reserved),
      limit: Number(row.cloud_transformations),
    },
  });
}

export async function requestAccountDeletion(authUserId: string): Promise<void> {
  try {
    await getSql().query('SELECT request_pressay_account_deletion($1)', [authUserId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('account_not_found')) {
      throw new ApiError(404, 'account_not_found', 'Account not found');
    }
    throw error;
  }
}
