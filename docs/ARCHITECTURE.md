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
   provider. A second atomic claim prevents concurrent provider calls for the
   same idempotency key; the reservation is then finalized or released.
6. Structured logs include only operation metadata from a fixed allowlist.

## Data stores

- Neon Postgres stores account metadata, devices, billing state, usage counters,
  idempotency records and encrypted sync blobs.
- Provider payloads are never written to Postgres, Vercel logs or traces.
- Transformation calls use the Responses API with `store: false` and in-memory
  prompt-cache retention. Audio transcription uses the stateless transcription
  endpoint. Pressay retains neither response.
- Private keys remain in the macOS Keychain. Neon stores only device public keys,
  encrypted account-key envelopes and ciphertext.

## Deployment

- The new backend is validated manually in the isolated Vercel project
  `pressay-cloud-staging`; it does not own `api.press-say.app`.
- Git auto-deploy is intentionally disconnected until the stacked backend pull
  requests are merged and Preview has its own isolated credentials.
- SQL is tested on a Neon child branch before production application.
- Production deploys use `fra1` and a pooled Neon URL in the same EU region.
- Migrations use the direct URL and run as a separate release operation.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the staging boundary, required gates and
domain cutover procedure.

## Cloud processing aliases

The client knows only stable Pressay aliases. Deployment configuration maps
`pressay-transform-v1` and `pressay-transcribe-v1` to pinned provider snapshots,
so a provider migration does not require a desktop release. Model identifiers
and provider credentials never come from client input.

The transformation route accepts at most 50,000 transcript characters and
20,000 selected-context characters. The transcription route accepts only
validated 16-bit PCM WAV at 8–48 kHz, mono or stereo, up to 4 MB and 180 seconds.
Both routes require `contentTransferAcknowledged: true` and never silently
fallback from a local request.

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

## App Store billing

The Mac App Store build passes the Pressay account UUID as StoreKit's
`appAccountToken`. `POST /v1/billing/restore-app-store` accepts only a signed
StoreKit 2 transaction whose token matches the authenticated account, refreshes
the subscription through the App Store Server API, and verifies every returned
JWS. `POST /v1/webhooks/apple` accepts only App Store Server Notifications V2.

Apple signatures are validated by Apple's official Node library with online
certificate checks and the three public Apple roots in
`config/apple-root-ca.pem`. Production verification also pins the App Apple ID
and the Store bundle ID. The App Store Connect API private key is Base64-encoded
only for transport in the `APP_STORE_PRIVATE_KEY_BASE64` Vercel secret; it is
never committed.

`recompute_pressay_entitlement` selects the longest currently valid Stripe or
App Store subscription, preserves a longer support grant, and increments the
signed entitlement revision only when effective rights change. Refunds,
revocations and out-of-order provider events therefore cannot silently erase a
different current entitlement.
