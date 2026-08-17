import { z } from 'zod';

import type { SyncChangeInput } from '../contracts/sync.js';
import { syncChangesResponseSchema } from '../contracts/sync.js';
import { getSql } from '../db/client.js';
import { ApiError } from '../lib/errors.js';

const syncRowSchema = z.object({
  sequence_id: z.coerce.number().int().positive(),
  source_device_id: z.uuid(),
  object_type: z.enum(['mode', 'profile', 'dictionary', 'preference']),
  client_object_id: z.uuid(),
  revision: z.coerce.number().int().positive(),
  envelope: z.string(),
  envelope_version: z.coerce.number().int().positive(),
  tombstone: z.boolean(),
  created_at: z.coerce.date(),
  conflict: z.boolean(),
});

function decodeBoundedBase64(value: string, minimum: number, maximum: number): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < minimum || decoded.length > maximum) {
    throw new ApiError(
      422,
      'invalid_encrypted_envelope',
      'Encrypted envelope size is invalid',
    );
  }
  if (decoded.toString('base64') !== value) {
    throw new ApiError(422, 'invalid_base64', 'Value is not canonical Base64');
  }
  return decoded;
}

export async function enrollSyncDevice(
  authUserId: string,
  deviceId: string,
  publicKeyBase64: string,
  encryptedAccountKeyBase64?: string,
): Promise<'approved' | 'pending'> {
  const publicKey = decodeBoundedBase64(publicKeyBase64, 32, 512);
  const encryptedAccountKey = encryptedAccountKeyBase64
    ? decodeBoundedBase64(encryptedAccountKeyBase64, 48, 16_384)
    : undefined;
  const rows = await getSql().query(
    `WITH target AS (
      SELECT d.id, d.account_id,
        NOT EXISTS (
          SELECT 1 FROM pressay_device approved
          WHERE approved.account_id = d.account_id
            AND approved.approved_at IS NOT NULL
            AND approved.revoked_at IS NULL
        ) AS first_device
      FROM pressay_device d
      JOIN pressay_account a ON a.id = d.account_id
      JOIN entitlement e ON e.account_id = a.id
      WHERE d.id = $1
        AND a.auth_user_id = $2
        AND a.status = 'active'
        AND d.revoked_at IS NULL
        AND e.tier = 'pro'
        AND e.valid_until > now()
    )
    UPDATE pressay_device d
    SET
      public_key = COALESCE(d.public_key, decode($3, 'hex')),
      encrypted_account_key = CASE
        WHEN target.first_device THEN decode($4, 'hex')
        ELSE d.encrypted_account_key
      END,
      approved_at = CASE WHEN target.first_device THEN now() ELSE d.approved_at END
    FROM target
    WHERE d.id = target.id
      AND (NOT target.first_device OR $4 <> '')
      AND (d.public_key IS NULL OR d.public_key = decode($3, 'hex'))
    RETURNING d.approved_at IS NOT NULL AS approved`,
    [
      deviceId,
      authUserId,
      publicKey.toString('hex'),
      encryptedAccountKey?.toString('hex') ?? '',
    ],
  );
  const result = z.object({ approved: z.boolean() }).safeParse(rows[0]);
  if (!result.success) {
    throw new ApiError(
      403,
      'sync_enrollment_rejected',
      encryptedAccountKey
        ? 'Device cannot enroll for sync'
        : 'The first sync device requires an encrypted account key',
    );
  }
  return result.data.approved ? 'approved' : 'pending';
}

interface SyncDevice {
  id: string;
  displayName: string;
  publicKey: string;
  status: 'approved' | 'pending';
}

export async function listSyncDevices(
  authUserId: string,
  approverDeviceId: string,
): Promise<SyncDevice[]> {
  const rows = await getSql().query(
    `SELECT
      target.id,
      target.display_name,
      encode(target.public_key, 'base64') AS public_key,
      target.approved_at IS NOT NULL AS approved
    FROM pressay_device approver
    JOIN pressay_account account ON account.id = approver.account_id
    JOIN entitlement entitlement ON entitlement.account_id = account.id
    JOIN pressay_device target ON target.account_id = account.id
    WHERE approver.id = $1
      AND account.auth_user_id = $2
      AND account.status = 'active'
      AND approver.approved_at IS NOT NULL
      AND approver.revoked_at IS NULL
      AND entitlement.tier = 'pro'
      AND entitlement.valid_until > now()
      AND target.public_key IS NOT NULL
      AND target.revoked_at IS NULL
    ORDER BY target.created_at ASC`,
    [approverDeviceId, authUserId],
  );
  return rows.map((unparsedRow) => {
    const row = z
      .object({
        id: z.uuid(),
        display_name: z.string().min(1).max(120),
        public_key: z.string(),
        approved: z.boolean(),
      })
      .parse(unparsedRow);
    return {
      id: row.id,
      displayName: row.display_name,
      publicKey: decodeBoundedBase64(row.public_key, 32, 512).toString('base64'),
      status: row.approved ? ('approved' as const) : ('pending' as const),
    };
  });
}

export async function getSyncDeviceEnvelope(
  authUserId: string,
  deviceId: string,
): Promise<{ encryptedAccountKey: string }> {
  const rows = await getSql().query(
    `SELECT encode(device.encrypted_account_key, 'base64') AS encrypted_account_key
    FROM pressay_device device
    JOIN pressay_account account ON account.id = device.account_id
    JOIN entitlement entitlement ON entitlement.account_id = account.id
    WHERE device.id = $1
      AND account.auth_user_id = $2
      AND account.status = 'active'
      AND device.approved_at IS NOT NULL
      AND device.revoked_at IS NULL
      AND device.encrypted_account_key IS NOT NULL
      AND entitlement.tier = 'pro'
      AND entitlement.valid_until > now()`,
    [deviceId, authUserId],
  );
  const result = z.object({ encrypted_account_key: z.string() }).safeParse(rows[0]);
  if (!result.success) {
    throw new ApiError(403, 'sync_envelope_unavailable', 'Sync envelope unavailable');
  }
  return {
    encryptedAccountKey: decodeBoundedBase64(
      result.data.encrypted_account_key,
      48,
      16_384,
    ).toString('base64'),
  };
}

export async function approveSyncDevice(
  authUserId: string,
  targetDeviceId: string,
  approverDeviceId: string,
  encryptedAccountKeyBase64: string,
): Promise<void> {
  const encryptedAccountKey = decodeBoundedBase64(
    encryptedAccountKeyBase64,
    48,
    16_384,
  );
  const rows = await getSql().query(
    `UPDATE pressay_device target
    SET encrypted_account_key = decode($4, 'hex'), approved_at = now()
    FROM pressay_device approver
    JOIN pressay_account account ON account.id = approver.account_id
    JOIN entitlement e ON e.account_id = account.id
    WHERE target.id = $1
      AND approver.id = $2
      AND account.auth_user_id = $3
      AND target.account_id = account.id
      AND target.public_key IS NOT NULL
      AND target.revoked_at IS NULL
      AND (
        target.approved_at IS NULL
        OR target.encrypted_account_key = decode($4, 'hex')
      )
      AND approver.approved_at IS NOT NULL
      AND approver.revoked_at IS NULL
      AND e.tier = 'pro'
      AND e.valid_until > now()
    RETURNING target.id`,
    [targetDeviceId, approverDeviceId, authUserId, encryptedAccountKey.toString('hex')],
  );
  if (rows.length === 0) {
    throw new ApiError(403, 'sync_approval_rejected', 'Device approval was rejected');
  }
}

export async function configureSyncRecovery(
  authUserId: string,
  deviceId: string,
  codeHashBase64: string,
  encryptedAccountKeyBase64: string,
): Promise<void> {
  const accountId = await assertApprovedSyncDevice(authUserId, deviceId);
  const codeHash = decodeBoundedBase64(codeHashBase64, 32, 32);
  const encryptedAccountKey = decodeBoundedBase64(
    encryptedAccountKeyBase64,
    48,
    16_384,
  );
  await getSql().query(
    `INSERT INTO account_recovery_code (account_id, code_hash, encrypted_account_key)
    VALUES ($1, decode($2, 'hex'), decode($3, 'hex'))
    ON CONFLICT (account_id) DO UPDATE SET
      code_hash = EXCLUDED.code_hash,
      encrypted_account_key = EXCLUDED.encrypted_account_key,
      rotated_at = now()`,
    [accountId, codeHash.toString('hex'), encryptedAccountKey.toString('hex')],
  );
}

export async function deleteSyncRecovery(
  authUserId: string,
  deviceId: string,
): Promise<void> {
  const accountId = await assertApprovedSyncDevice(authUserId, deviceId);
  await getSql().query(`DELETE FROM account_recovery_code WHERE account_id = $1`, [
    accountId,
  ]);
}

export async function beginSyncRecovery(
  authUserId: string,
  deviceId: string,
  publicKeyBase64: string,
  codeHashBase64: string,
): Promise<{ encryptedAccountKey: string }> {
  const publicKey = decodeBoundedBase64(publicKeyBase64, 32, 512);
  const codeHash = decodeBoundedBase64(codeHashBase64, 32, 32);
  const rows = await getSql().query(
    `UPDATE pressay_device device
    SET public_key = COALESCE(device.public_key, decode($3, 'hex'))
    FROM pressay_account account
    JOIN entitlement entitlement ON entitlement.account_id = account.id
    JOIN account_recovery_code recovery ON recovery.account_id = account.id
    WHERE device.id = $1
      AND account.auth_user_id = $2
      AND device.account_id = account.id
      AND account.status = 'active'
      AND device.revoked_at IS NULL
      AND entitlement.tier = 'pro'
      AND entitlement.valid_until > now()
      AND recovery.code_hash = decode($4, 'hex')
      AND (device.public_key IS NULL OR device.public_key = decode($3, 'hex'))
    RETURNING encode(recovery.encrypted_account_key, 'base64') AS encrypted_account_key`,
    [deviceId, authUserId, publicKey.toString('hex'), codeHash.toString('hex')],
  );
  const result = z.object({ encrypted_account_key: z.string() }).safeParse(rows[0]);
  if (!result.success) {
    throw new ApiError(403, 'sync_recovery_rejected', 'Sync recovery was rejected');
  }
  return { encryptedAccountKey: result.data.encrypted_account_key };
}

export async function completeSyncRecovery(
  authUserId: string,
  deviceId: string,
  codeHashBase64: string,
  encryptedAccountKeyBase64: string,
): Promise<void> {
  const codeHash = decodeBoundedBase64(codeHashBase64, 32, 32);
  const encryptedAccountKey = decodeBoundedBase64(
    encryptedAccountKeyBase64,
    48,
    16_384,
  );
  const rows = await getSql().query(
    `WITH recovered AS (
      UPDATE pressay_device device
      SET
        encrypted_account_key = decode($4, 'hex'),
        approved_at = COALESCE(device.approved_at, now())
      FROM pressay_account account
      JOIN entitlement entitlement ON entitlement.account_id = account.id
      JOIN account_recovery_code recovery ON recovery.account_id = account.id
      WHERE device.id = $1
        AND account.auth_user_id = $2
        AND device.account_id = account.id
        AND account.status = 'active'
        AND device.public_key IS NOT NULL
        AND device.revoked_at IS NULL
        AND entitlement.tier = 'pro'
        AND entitlement.valid_until > now()
        AND recovery.code_hash = decode($3, 'hex')
        AND (
          device.approved_at IS NULL
          OR device.encrypted_account_key = decode($4, 'hex')
        )
      RETURNING device.id, device.account_id
    )
    DELETE FROM account_recovery_code recovery
    USING recovered
    WHERE recovery.account_id = recovered.account_id
    RETURNING recovered.id`,
    [
      deviceId,
      authUserId,
      codeHash.toString('hex'),
      encryptedAccountKey.toString('hex'),
    ],
  );
  if (rows.length === 0) {
    throw new ApiError(403, 'sync_recovery_rejected', 'Sync recovery was rejected');
  }
}

async function assertApprovedSyncDevice(
  authUserId: string,
  deviceId: string,
): Promise<string> {
  const rows = await getSql().query(
    `SELECT a.id AS account_id
    FROM pressay_device d
    JOIN pressay_account a ON a.id = d.account_id
    JOIN entitlement e ON e.account_id = a.id
    WHERE d.id = $1
      AND a.auth_user_id = $2
      AND a.status = 'active'
      AND d.approved_at IS NOT NULL
      AND d.revoked_at IS NULL
      AND e.tier = 'pro'
      AND e.valid_until > now()`,
    [deviceId, authUserId],
  );
  const row = z.object({ account_id: z.uuid() }).safeParse(rows[0]);
  if (!row.success) {
    throw new ApiError(403, 'sync_device_not_approved', 'Approved Pro device required');
  }
  return row.data.account_id;
}

export async function appendSyncChanges(
  authUserId: string,
  deviceId: string,
  changes: readonly SyncChangeInput[],
): Promise<{ accepted: number; conflicts: number; cursor: number }> {
  const accountId = await assertApprovedSyncDevice(authUserId, deviceId);
  const encodedChanges = changes.map((change) => ({
    object_type: change.objectType,
    object_id: change.objectId,
    revision: change.revision,
    envelope_hex: decodeBoundedBase64(change.envelope, 48, 1_048_576).toString('hex'),
    envelope_version: change.envelopeVersion,
    tombstone: change.tombstone,
  }));
  const rows = await getSql().query(
    `WITH input AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS item(
        object_type text,
        object_id uuid,
        revision bigint,
        envelope_hex text,
        envelope_version smallint,
        tombstone boolean
      )
    ), inserted AS (
      INSERT INTO sync_change (
        account_id, source_device_id, object_type, client_object_id,
        revision, encrypted_envelope, envelope_version, tombstone
      )
      SELECT
        $1, $2, input.object_type, input.object_id, input.revision,
        decode(input.envelope_hex, 'hex'), input.envelope_version, input.tombstone
      FROM input
      ON CONFLICT (account_id, object_type, client_object_id, revision, source_device_id)
      DO NOTHING
      RETURNING sequence_id, object_type, client_object_id, revision
    )
    SELECT
      count(*)::integer AS accepted,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM sync_change other
        WHERE other.account_id = $1
          AND other.object_type = inserted.object_type
          AND other.client_object_id = inserted.client_object_id
          AND other.revision = inserted.revision
          AND other.source_device_id <> $2
      ))::integer AS conflicts,
      COALESCE(max(sequence_id), 0)::bigint AS cursor
    FROM inserted`,
    [accountId, deviceId, JSON.stringify(encodedChanges)],
  );
  return z
    .object({
      accepted: z.coerce.number().int().nonnegative(),
      conflicts: z.coerce.number().int().nonnegative(),
      cursor: z.coerce.number().int().nonnegative(),
    })
    .parse(rows[0]);
}

export async function getSyncChanges(
  authUserId: string,
  deviceId: string,
  after: number,
  limit: number,
) {
  const accountId = await assertApprovedSyncDevice(authUserId, deviceId);
  const rows = await getSql().query(
    `SELECT
      change.sequence_id,
      change.source_device_id,
      change.object_type,
      change.client_object_id,
      change.revision,
      encode(change.encrypted_envelope, 'base64') AS envelope,
      change.envelope_version,
      change.tombstone,
      change.created_at,
      EXISTS (
        SELECT 1 FROM sync_change conflict
        WHERE conflict.account_id = change.account_id
          AND conflict.object_type = change.object_type
          AND conflict.client_object_id = change.client_object_id
          AND conflict.revision = change.revision
          AND conflict.source_device_id <> change.source_device_id
      ) AS conflict
    FROM sync_change change
    WHERE change.account_id = $1 AND change.sequence_id > $2
    ORDER BY change.sequence_id ASC
    LIMIT $3`,
    [accountId, after, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((unparsedRow) => {
    const row = syncRowSchema.parse(unparsedRow);
    return {
      sequenceId: row.sequence_id,
      sourceDeviceId: row.source_device_id,
      objectType: row.object_type,
      objectId: row.client_object_id,
      revision: row.revision,
      envelope: row.envelope,
      envelopeVersion: row.envelope_version,
      tombstone: row.tombstone,
      createdAt: row.created_at.toISOString(),
      conflict: row.conflict,
    };
  });
  return syncChangesResponseSchema.parse({
    changes: page,
    nextCursor: page.at(-1)?.sequenceId ?? after,
    hasMore,
  });
}
