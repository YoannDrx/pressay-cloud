import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  getEntitlementPublicJwk,
  signEntitlementSnapshot,
} from '../src/services/entitlements.ts';

const { privateKey } = generateKeyPairSync('ed25519');
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
const now = Date.parse('2026-08-17T00:00:00.000Z') / 1000;
const baseInput = {
  accountId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  usage: {
    periodStart: '2026-08-01',
    transcription: { usedSeconds: 42, reservedSeconds: 8, limitSeconds: 36000 },
    transformations: { used: 5, reserved: 1, limit: 2000 },
  },
};

describe('signed entitlement snapshots', () => {
  it('binds a Pro snapshot to its account and device for at most 72 hours', async () => {
    const snapshot = await signEntitlementSnapshot(
      {
        ...baseInput,
        entitlement: {
          tier: 'pro',
          source: 'trial',
          validFrom: '2026-08-16T00:00:00.000Z',
          validUntil: '2026-08-31T00:00:00.000Z',
          offlineGraceUntil: '2026-09-03T00:00:00.000Z',
          revision: 1,
        },
      },
      privateKeyPem,
      'test-key',
      now,
    );
    const verificationKey = await importJWK(publicJwk, 'EdDSA');
    const verified = await jwtVerify(snapshot.token, verificationKey, {
      issuer: 'https://api.press-say.app',
      audience: 'app.pressay.desktop',
      currentDate: new Date(now * 1000),
    });

    expect(verified.protectedHeader).toMatchObject({ alg: 'EdDSA', kid: 'test-key' });
    expect(verified.payload).toMatchObject({
      sub: baseInput.accountId,
      device_id: baseInput.deviceId,
      tier: 'pro',
      source: 'trial',
    });
    expect(verified.payload.exp).toBe(now + 72 * 60 * 60);
  });

  it('downgrades an expired Pro record to a short free snapshot', async () => {
    const snapshot = await signEntitlementSnapshot(
      {
        ...baseInput,
        entitlement: {
          tier: 'pro',
          source: 'trial',
          validFrom: '2026-07-01T00:00:00.000Z',
          validUntil: '2026-08-16T00:00:00.000Z',
          offlineGraceUntil: '2026-08-19T00:00:00.000Z',
          revision: 2,
        },
      },
      privateKeyPem,
      'test-key',
      now,
    );
    const verificationKey = await importJWK(publicJwk, 'EdDSA');
    const verified = await jwtVerify(snapshot.token, verificationKey, {
      currentDate: new Date(now * 1000),
    });
    expect(verified.payload).toMatchObject({ tier: 'free', source: 'none' });
    expect(verified.payload.exp).toBe(now + 24 * 60 * 60);
  });

  it('publishes only the public JWK', () => {
    const jwk = getEntitlementPublicJwk(privateKeyPem, 'test-key');
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'test-key' });
    expect(jwk).not.toHaveProperty('d');
  });
});
