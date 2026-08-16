# Pressay Cloud architecture

## Boundaries

The desktop application is local-first. This service is a private control plane
for accounts, devices, subscriptions, usage reservations and opaque E2EE sync
envelopes. Cloud text and audio processing is stateless.

## Request path

1. Vercel terminates TLS in the EU function region.
2. Hono assigns an opaque request ID and applies security headers and an explicit
   CORS allowlist.
3. Better Auth resolves a short-lived session or bearer token.
4. Protected handlers verify the device and current server entitlement.
5. Billable operations reserve quota transactionally before contacting a
   provider, then finalize or release the reservation.
6. Structured logs include only operation metadata from a fixed allowlist.

## Data stores

- Neon Postgres stores account metadata, devices, billing state, usage counters,
  idempotency records and encrypted sync blobs.
- Provider payloads are never written to Postgres, Vercel logs or traces.
- Private keys remain in the macOS Keychain. Neon stores only device public keys,
  encrypted account-key envelopes and ciphertext.

## Deployment

- Pull requests receive Vercel previews with isolated credentials.
- SQL is tested on a Neon child branch before production application.
- Production deploys use `fra1` and a pooled Neon URL in the same EU region.
- Migrations use the direct URL and run as a separate release operation.

## Entitlement signing

The server signs device-bound entitlement snapshots with Ed25519. The first key
is `pressay-entitlement-2026-01`; its private PKCS#8 PEM is stored Base64-encoded
in the macOS Keychain under service `app.pressay.cloud.entitlement-signing`. It
must be decoded back to PEM before it is copied to the Vercel production secret
`ENTITLEMENT_SIGNING_PRIVATE_KEY` at deployment.
Only [the public JWKS](../config/entitlement-jwks.json) is committed and embedded
by the desktop application.

Rotation is additive: publish and embed the new public key, deploy the server so
it signs with the new `kid`, wait at least 72 hours (the maximum offline grace),
then remove the old public key. Private keys are never stored in GitHub.
