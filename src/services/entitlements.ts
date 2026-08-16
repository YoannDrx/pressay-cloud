import { createPublicKey } from 'node:crypto';

import { importPKCS8, SignJWT, type JWK } from 'jose';

import type { Entitlement, UsageSnapshot } from '../contracts/account.ts';
import { getEnvironment, requireEnvironmentValue } from '../env.ts';

const maxOfflineGraceSeconds = 72 * 60 * 60;

export interface EntitlementSnapshotInput {
  accountId: string;
  deviceId: string;
  entitlement: Entitlement;
  usage: UsageSnapshot;
}

function parseBoundary(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Math.floor(new Date(value).getTime() / 1000);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function resolvePrivateKey(privateKeyPem?: string): string {
  if (privateKeyPem) return privateKeyPem.replaceAll('\\n', '\n');
  const environment = getEnvironment();
  return requireEnvironmentValue(
    environment.ENTITLEMENT_SIGNING_PRIVATE_KEY,
    'ENTITLEMENT_SIGNING_PRIVATE_KEY',
  ).replaceAll('\\n', '\n');
}

export async function signEntitlementSnapshot(
  input: EntitlementSnapshotInput,
  privateKeyPem?: string,
  keyId?: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ token: string; keyId: string; expiresAt: string }> {
  const resolvedKeyId = keyId ?? getEnvironment().ENTITLEMENT_SIGNING_KEY_ID;
  const key = await importPKCS8(resolvePrivateKey(privateKeyPem), 'EdDSA');
  const onlineValidUntil = parseBoundary(input.entitlement.validUntil);
  const offlineGraceUntil = parseBoundary(input.entitlement.offlineGraceUntil);
  const effectivePro =
    input.entitlement.tier === 'pro' &&
    onlineValidUntil !== undefined &&
    onlineValidUntil > nowSeconds;
  const maximumExpiry = nowSeconds + maxOfflineGraceSeconds;
  const expiry = effectivePro
    ? Math.min(offlineGraceUntil ?? onlineValidUntil, maximumExpiry)
    : Math.min(nowSeconds + 24 * 60 * 60, maximumExpiry);

  const token = await new SignJWT({
    tier: effectivePro ? 'pro' : 'free',
    source: effectivePro ? input.entitlement.source : 'none',
    revision: input.entitlement.revision,
    device_id: input.deviceId,
    online_valid_until: onlineValidUntil,
    offline_grace_until: offlineGraceUntil,
    usage: {
      period_start: input.usage.periodStart,
      transcription_seconds_used: input.usage.transcription.usedSeconds,
      transcription_seconds_limit: input.usage.transcription.limitSeconds,
      transformations_used: input.usage.transformations.used,
      transformations_limit: input.usage.transformations.limit,
    },
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: resolvedKeyId, typ: 'JWT' })
    .setIssuer('https://api.press-say.app')
    .setAudience(['app.pressay.desktop', 'app.pressay.desktop.mas'])
    .setSubject(input.accountId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiry)
    .sign(key);

  return {
    token,
    keyId: resolvedKeyId,
    expiresAt: new Date(expiry * 1000).toISOString(),
  };
}

export function getEntitlementPublicJwk(privateKeyPem?: string, keyId?: string): JWK {
  const resolvedKeyId = keyId ?? getEnvironment().ENTITLEMENT_SIGNING_KEY_ID;
  const publicJwk = createPublicKey(resolvePrivateKey(privateKeyPem)).export({
    format: 'jwk',
  }) as JWK;
  return {
    ...publicJwk,
    kid: resolvedKeyId,
    alg: 'EdDSA',
    use: 'sig',
  };
}
