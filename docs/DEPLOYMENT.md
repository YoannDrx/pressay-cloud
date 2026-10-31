# Pressay Cloud deployment

## Environments

Two canonical deployments exist. Staging:

- Vercel project: `pressay-cloud-staging`
- URL: `https://pressay-cloud-staging.vercel.app`
- Runtime: Node.js 22, Hono, region `fra1`
- Database: Neon project `snowy-meadow-52007899`, branch
  `br-old-rain-asfu6s3y`, database `pressay`, schema
  `0019_billing_hardening.sql` once this release is applied
- Branch parent/restore source: `br-plain-sunset-asxlyj0q`, validated before the
  staging branch was created
- Cloud processing: disabled by default

Production serves `https://api.press-say.app` (domain attached to
`pressay-cloud-production` since late August 2026; the legacy `pressay-api`
project only keeps `pressay-api.vercel.app`):

- Vercel project: `pressay-cloud-production`
- Vercel project ID: `prj_wjK1Ur48HVNXiNwgoPJKilFoCHem`
- Git source: `YoannDrx/pressay-cloud`, production branch `main`
- Runtime contract: Node.js 22 from `package.json`, Hono, region `fra1`
- Neon project: `wandering-boat-94901475`, region `aws-eu-central-1`
- Neon primary branch: `br-square-king-b224neq5`, database `pressay_cloud`
- Pre-schema restore branch: `br-ancient-bird-b2mvkrex`
- Schema: `0018_referral_reversal_replay.sql` before this release;
  `0019_billing_hardening.sql` must be applied before deploying it
- Cloud processing and Stripe commercial launch: disabled
- Entitlement signing key: `pressay-entitlement-production-2026-01` (the
  environment parser rejects any other prefix in production)

The Vercel project has independent production secrets and is connected to Git;
production deployments come only from immutable `main` commits. The legacy
`pressay-api` project is outside this repository's deployment flow.

Preview deployments must not connect to the production database. Keep previews
disabled or attach a dedicated Neon branch before enabling non-`main` Git deploys.

Set `PRESSAY_DEPLOYMENT_ENV=staging` on the canonical staging project and
`PRESSAY_DEPLOYMENT_ENV=production` on the customer-facing project. Vercel's own
`VERCEL_ENV` value cannot distinguish these two deployments because each
project's canonical deployment is reported as `production`.

Both canonical environments are also pinned to Vercel's system-provided
`VERCEL_PROJECT_ID`. Staging accepts only project
`prj_QKq9S0LqVbPQD6qvFZDiVNldSzLE`; production accepts only
`prj_wjK1Ur48HVNXiNwgoPJKilFoCHem`. Keep automatic system environment variables
enabled in both projects. A missing or mismatched project ID fails the build and
runtime environment validation.

## Required variables

Environment variables are encrypted in their respective Vercel projects; the
authoritative list with defaults is `.env.example` and `src/env.ts`. A
production deploy requires at least:

- `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `PRESSAY_DEPLOYMENT_ENV=production`
- `PRESSAY_API_URL`, `PRESSAY_ALLOWED_ORIGINS` (exact origins; normalized)
- identity: `PRESSAY_BETTER_AUTH_JWT_ISSUER`, `PRESSAY_BETTER_AUTH_JWKS_URL`,
  `PRESSAY_BETTER_AUTH_JWT_AUDIENCE`, `PRESSAY_WEB_PROXY_JWT_AUDIENCE`,
  `PRESSAY_WEB_PROXY_LEGACY_AUDIENCE_ALLOWED`, `PRESSAY_DESKTOP_OAUTH_CLIENT_ID`
- web/Cloud internal calls: `PRESSAY_INTERNAL_JWT_ISSUER`,
  `PRESSAY_INTERNAL_JWT_SECRET`, `PRESSAY_CLOUD_INTERNAL_JWT_ISSUER`,
  `PRESSAY_WEB_INTERNAL_ORIGIN` (account deletion removes the web identity)
- `DEVICE_IDENTIFIER_HMAC_SECRET`, `RATE_LIMIT_HMAC_SECRET`, `CRON_SECRET`,
  `PRESSAY_CAMPAIGN_SECRET`, `PRESSAY_OPERATIONS_OWNER_EMAILS`
- `ENTITLEMENT_SIGNING_PRIVATE_KEY`, `ENTITLEMENT_SIGNING_KEY_ID`
- the `APP_STORE_*` set, `APPLE_APP_BUNDLE_IDENTIFIER` and the
  `APPLE_SANDBOX_*` review policy
- the `STRIPE_*` set, including `STRIPE_AUTOMATIC_TAX_ENABLED`,
  `STRIPE_TAX_ID_COLLECTION_ENABLED`, `STRIPE_PRODUCT_TAX_CODE` and
  `STRIPE_PAST_DUE_GRACE_DAYS`
- `PRESSAY_CLOUD_PROCESSING_ENABLED=false` until `OPENAI_API_KEY` and the
  retention wording are in place

Optional: `OPS_ALERT_WEBHOOK_URL` (HTTPS). The daily `ops-digest` cron
(06:00 UTC, `CRON_SECRET`) always logs `ops_digest.completed` with the billing
counters (failed webhooks, open disputes, unpaid and duplicate subscriptions,
refunds and failed payments in 24 h); when the variable is set it also posts
the same counters as JSON (`service`, `environment`, `generatedAt`,
`attention`, `counters`), without identifiers or emails, with a 5-second
timeout and no redirect.

Cloud no longer runs its own Better Auth. All end-user identity comes from the
OAuth 2.1 issuer on `press-say.app`; `BETTER_AUTH_SECRET`, `RESEND_API_KEY`,
`PRESSAY_AUTH_FROM_EMAIL`, `GOOGLE_CLIENT_*` and the Sign in with Apple
`APPLE_CLIENT_ID`/`APPLE_TEAM_ID`/`APPLE_KEY_ID`/`APPLE_PRIVATE_KEY` variables
are no longer read and should be removed from both Vercel projects. The retired
`/v1/desktop-auth/social/*`, `/callback`, `/error` and `/v1/auth/*` routes answer
410 `desktop_auth_moved_to_web`.

Stripe credentials are pinned to the declared Pressay environment. Canonical
staging accepts only a restricted `rk_test_` key and Stripe test-mode Product
and Price objects. Production accepts only a restricted `rk_live_` key and
live-mode catalogue objects. Development rejects live keys. The environment
parser fails closed if commercial launch is enabled outside production or if
the key, expected account, webhook secret, Product, monthly Price or annual
Price is missing. Standard `sk_` keys are not valid for canonical deployments.

Provision and audit the staging catalogue in Stripe test mode before merging a
change that activates these boundaries. Do the same independently for live
production. Never copy live Price IDs into staging, even though Stripe uses the
same account ID in both modes.

App Store development and staging accept only Apple Sandbox payloads.
Production verifies Production first, then Sandbox for App Review and TestFlight
while `APPLE_SANDBOX_IN_PRODUCTION_ENABLED=true`. In production a Sandbox
purchase grants Pro only to the Pressay accounts listed in
`APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS`; with an empty list no account receives
anything (restores answer 403 `app_store_sandbox_not_allowed`, notifications are
recorded as ignored with `sandbox_account_not_allowed`). A Sandbox grant lasts at
most `APPLE_SANDBOX_MAX_GRANT_HOURS` from the first Sandbox purchase, carries no
offline grace and is flagged `entitlement.sandbox`. A flagged entitlement keeps
Pro in the app but never unlocks the paid Cloud services: Cloud processing
answers 403 `cloud_entitlement_required` and E2EE sync refuses the device.

### App Review accounts

Before each App Store submission backed by the production API:

1. Create the demo account given to App Review in App Store Connect and sign in
   with it once in the submitted build, so its Pressay Cloud account exists.
2. Read its account UUID (`pressay_account.id`, also shown as `id` by the
   owner-only `GET /v1/admin/users?search=<email>`).
3. Add it to `APPLE_SANDBOX_ALLOWED_ACCOUNT_IDS` in the production Vercel
   project (comma-separated UUIDs) and redeploy production so the value is read.
4. Ask App Review, in the review notes, to purchase with that demo account. A
   Sandbox purchase made from any other Pressay account grants nothing.
5. Remove the UUID once the review is complete.

If App Review must exercise Cloud processing or sync, give the demo account a
time-limited invitation grant (see [OPERATIONS_ROLLOUT.md](OPERATIONS_ROLLOUT.md))
instead of relying on the Sandbox purchase.
Both paths require Apple's signature, the configured bundle and an account-bound
transaction, followed by a status refresh against the matching Apple Server API.
Sandbox subscriptions use a separate ID namespace and never change the production
customer linkage. Paid subscriptions take precedence; test access receives no
extra offline grace beyond Apple's verified expiry.

Apply migration `0019_billing_hardening.sql` before deploying this release: it
adds `billing_subscription.grace_ends_at` and `entitlement.sandbox` and replaces
`recompute_pressay_entitlement` (past_due grace cap, Sandbox flag). It is
additive and re-projects only past_due and Sandbox accounts.

Migration `0016_app_review_sandbox.sql` (already applied)
It also fixes billing finalization: sibling data-modifying CTEs share a snapshot,
so an outer UPDATE could not see the provider event just inserted. Apple and
Stripe now finalize and recompute access within a dependent volatile function.
Verify on a production clone before rollout. Configure both Apple notification
URLs to the API used by the submitted build; a production-backed review build
requires Sandbox notifications at the production webhook too.

The staging cron secret also has an operator copy in the macOS Keychain under
service `app.pressay.cloud.cron` and account `pressay-cloud-staging`. Secret
values must never be placed in shell history, GitHub, documentation or logs.

## Deploy and verify

Run the source and controlled migration gates before every promotion:

```bash
bun run ci:source
bun run release:prepare
vercel inspect --logs <git-integrated-main-deployment>
vercel curl /v1/health --deployment https://pressay-cloud-staging.vercel.app
vercel curl /v1/ready --deployment https://pressay-cloud-staging.vercel.app
PRESSAY_EXPECTED_CLOUD_AUTH_PROVIDERS=google,apple bun run validate:staging
```

Before moving the canonical domain, validate the temporary deployment URL while
keeping the configured callback explicit:

```bash
PRESSAY_STAGING_BASE_URL=https://pressay-cloud-staging.vercel.app \
PRESSAY_EXPECTED_AUTH_CALLBACK_URL=https://api-staging.press-say.app/v1/desktop-auth/callback \
PRESSAY_EXPECTED_CLOUD_AUTH_PROVIDERS=google,apple \
bun run validate:staging
```

`release:prepare` includes `billing:audit`; therefore it must run inside the
intended Vercel/secret context. Sensitive Vercel variables are write-only and
must not be exported into a local `.env` file as a workaround.

`build:deploy` rejects production deployments that are not attributed to a
40-character commit on `main`. Manual production deploys are therefore blocked;
use a Git-integrated immutable deployment and promote only after the migration
gate records the database restore point.

Expected results are HTTP 200 with process health and database readiness. The
maintenance route must return 401 without the cron token and 200 with the token.
Cloud transformation and transcription must remain unavailable while the kill
switch is false.

After verification, inspect the final deployment for 500 responses. Do not
disable Vercel Deployment Protection to test a protected deployment; use
`vercel curl`.

## Production cutover

The `api.press-say.app` cutover to `pressay-cloud-production` is done. Keep a
documented domain rollback target and never let a staging deployment reassign
the production domain. Before opening sales, the remaining gates are: Vercel Pro
(commercial use, hourly crons), Neon PITR beyond 6 hours plus logical dumps,
alerting on 5xx and webhook failures, Stripe Tax activation, and the production
entitlement key check (`GET /v1/entitlements/jwks` must return
`pressay-entitlement-production-2026-01`).

## Scheduled jobs

`vercel.json` runs `/v1/internal/jobs/account-deletions` and
`/v1/internal/jobs/referral-rewards` daily (Hobby limit). Each run works for up
to 50 s and reports `drained`. The deletion job also removes expired rate-limit
buckets and purges operational records (see the retention matrix in
ARCHITECTURE.md). Switch both to hourly after moving to Vercel Pro.

Migration `0014_migrate_legacy_accounts.sql` preserves the stable identity subject
and effective legacy entitlement before cutover. It deliberately does not copy
Stripe customer or subscription identifiers because those identifiers belong to
the Stripe account that created them. Reconcile provider records separately against
the dedicated Pressay account before enabling Checkout.
