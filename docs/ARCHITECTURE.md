# Pressay Cloud architecture

## Boundaries

The desktop application is local-first. This service is a private control plane
for accounts, devices, subscriptions, usage reservations and opaque E2EE sync
envelopes. Cloud text and audio processing is stateless.

## Request path

1. Vercel terminates TLS in the EU function region.
2. Hono assigns an opaque request ID and applies security headers and an explicit
   CORS allowlist.
3. A bearer token is verified: either an EdDSA access token from the single web
   identity issuer (audience `https://api.press-say.app`, JWKS), or an HS256
   web-proxy token (audience `pressay-web-proxy`, `token_use=pressay_web_proxy`).
   Rejections answer 401 with `WWW-Authenticate` and log a reason code.
4. Protected handlers verify the device and current server entitlement.
5. Billable operations reserve quota transactionally before contacting a
   provider. A second atomic claim prevents concurrent provider calls for the
   same idempotency key; the reservation is then finalized or released.
6. Sensitive endpoints (checkout, portal, App Store restore, deletion, export,
   referral code lookup) are rate-limited per user or IP with HMAC-hashed keys.
7. Structured logs include only operation metadata from a fixed allowlist;
   failures log the error class, a stable code, the cause chain and the route
   pattern, never messages or raw paths.

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

- `pressay-cloud-production` serves `api.press-say.app`; `pressay-cloud-staging`
  is the isolated staging project. Production deploys only from `main`.
- SQL is tested on a Neon child branch before production application; the
  current schema is `0019_billing_hardening.sql`.
- Production deploys use `fra1` and a pooled Neon URL in the same EU region.
- Migrations use the direct URL and run as a separate release operation.
- `.github/workflows/ci.yml` runs typecheck, lint, format, unit and PostgreSQL
  tests, migrations, secret scan and dependency audit on every pull request.

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

The server signs device-bound entitlement snapshots with Ed25519, one key per
environment, matching the keys pinned in the desktop app:

- staging and development: `pressay-entitlement-2026-01`;
- production: `pressay-entitlement-production-2026-01`.

The environment parser refuses a non-production key id in production and a
production key id elsewhere. Private PKCS#8 PEMs are stored Base64-encoded in
the macOS Keychain under service `app.pressay.cloud.entitlement-signing` and
decoded back to PEM before being copied to `ENTITLEMENT_SIGNING_PRIVATE_KEY` in
the matching Vercel project. Only [the public JWKS](../config/entitlement-jwks.json)
(both public keys) is committed.

Rotation is additive: publish and embed the new public key, deploy the server so
it signs with the new `kid`, wait at least 72 hours (the maximum offline grace),
then remove the old public key. Private keys are never stored in GitHub.

## App Store billing

The Mac App Store build passes the Pressay account UUID as StoreKit's
`appAccountToken`. `POST /v1/billing/restore-app-store` accepts a signed
StoreKit 2 transaction whose token matches the authenticated account; a purchase
without a token or bound to another token (offer codes, Family Sharing, another
Apple ID flow) is linked only when the client sends `linkToCurrentAccount: true`
after the user confirms, and never if another Pressay account owns it. It refreshes
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

Notifications without a usable `appAccountToken` that no account already owns
are acknowledged with 200 `{"status":"ignored","code":"missing_app_account_token"}`
and recorded as ignored, so Apple stops retrying. Processing failures are stored
as `provider_event.state='failed'` with a stable code and retried on redelivery.

## Stripe billing

Webhooks re-read the subscription from Stripe before projecting it, so out-of-
order and same-second events converge on Stripe's current state. Production
accepts only live-mode events and every other environment only test-mode
events; an event from the other mode is acknowledged with 200, logged as
`billing.webhook.livemode_mismatch` and never written to Postgres. A `past_due`
subscription keeps Pro for `STRIPE_PAST_DUE_GRACE_DAYS` from the period start at
most. A full refund or a lost dispute cancels the Stripe subscription
immediately; a won dispute restores Stripe's current state. Checkout refuses a
second live subscription (Stripe or App Store, 409), and a concurrent App Store
activation is flagged `duplicate_subscription_stripe_active` for support.
Checkout creation is serialized per account by a 90-second lease
(`billing_checkout_lease`; a concurrent request gets 409 `checkout_in_progress`).
Under the lease the service asks Stripe itself: an `active`, `trialing`,
`past_due` or `unpaid` subscription for the customer refuses with 409
`subscription_already_active` even before its webhook arrives, an open session
for the same Price is reused, and any other open session is expired before a
new one is created. Stripe
Tax is behind `STRIPE_AUTOMATIC_TAX_ENABLED`; catalogue prices are tax-inclusive.

## Account deletion

`DELETE /v1/me` answers 409 `apple_subscription_active` (with the App Store
subscriptions URL) while an App Store subscription is live, unless the client
retries with `?acknowledgeAppleSubscription=true`. The deletion job deletes the
Stripe customer, then calls the web `POST /api/internal/identity-deletion`
(HS256, audience `pressay-web-internal`) and only then removes the Cloud account;
any failure is retried with backoff.

A web proxy token may delete the account only with proof, bound to its web
session, of a sign-in (`pressay_auth_at`) or a second-factor step-up
(`pressay_step_up_at`) less than ten minutes old, matching the web session
`freshAge`. Otherwise the API answers 403 `recent_authentication_required`
(`maxAgeSeconds`), and the web asks the user to sign in again. Desktop OAuth
access tokens keep their existing deletion contract.

## Support reads

`/v1/admin/*` is reserved to the single operations owner. Reads that return a
person's data (`users`, `users/:id`, `referrals`) need a second-factor step-up
less than ten minutes old and are written to `operations_audit` as
`personal_data_read`, without the search terms.

`GET /v1/admin/users` recognises the format of the search: `cus_…` (Stripe
customer), `sub_…` (Stripe subscription), a decimal App Store original
transaction (production or Sandbox), a UUID (account, device or identity
subject), otherwise an email substring with `%` and `_` matched literally. Each
identifier is looked up on its own indexed column. Accounts without an
entitlement row are listed; Apple Sandbox access is reported as plan `sandbox`,
never as paid `pro`, here and in `GET /v1/admin/overview`.

`GET /v1/admin/users/:id` returns the support record: identity subject,
Stripe and App Store identifiers, full subscriptions, the last 50 financial
events, checkout consents, the deletion job, every device (revoked included),
twelve months of Cloud usage and the audit entries that target the account or
its grants (reads are counted, not listed). With `?include=identity`, the web
also reads linked sign-in methods, passkeys and sessions from its own database,
and the API records that read as `admin.user.identity.read`.

## Retention matrix

| Data                                                           | Retention                                                                   | Mechanism               |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------- |
| Account, devices, entitlement, usage counters, sync ciphertext | Until account deletion                                                      | Cascade on deletion job |
| Idempotency records                                            | 30 days after creation, once expired (`PRESSAY_RETENTION_IDEMPOTENCY_DAYS`) | Daily purge             |
| Settled usage reservations                                     | 395 days (`PRESSAY_RETENTION_USAGE_RESERVATION_DAYS`)                       | Daily purge             |
| Provider event receipts without financial record               | 400 days (`PRESSAY_RETENTION_PROVIDER_EVENT_DAYS`)                          | Daily purge             |
| Financial ledger (`billing_financial_event`) and its events    | Accounting obligation (10 years in France)                                  | Kept                    |
| `operations_audit`                                             | Kept for accountability                                                     | Kept                    |
| Rate-limit buckets                                             | Until window expiry                                                         | Daily purge             |
| Checkout leases (`billing_checkout_lease`)                     | Until the Checkout request ends; an abandoned lease is inert after 90 s     | Deleted by the request  |
| Retired Cloud sessions and verifications                       | Until expiry                                                                | Daily purge             |
| Deletion tombstone (`auth_user_id`)                            | Kept to prevent re-attribution                                              | Kept                    |
| Anonymous download events (`download_event`, no personal data) | Kept as aggregate statistics                                                | Kept                    |

`GET /v1/me/export` returns the caller's data as JSON (account, contact,
devices, entitlement, subscriptions, payments, consents, usage, grants, referral
data, sync volume) without hashes, keys or provider identifiers.
