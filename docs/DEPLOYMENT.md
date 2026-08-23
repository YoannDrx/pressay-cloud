# Pressay Cloud deployment

## Environments

The new control plane currently has one validated deployment target:

- Vercel project: `pressay-cloud-staging`
- URL: `https://pressay-cloud-staging.vercel.app`
- Runtime: Node.js 22, Hono, region `fra1`
- Database: Neon project `snowy-meadow-52007899`, branch
  `br-old-rain-asfu6s3y`, database `pressay`, schema
  `0014_migrate_legacy_accounts.sql`
- Branch parent/restore source: `br-plain-sunset-asxlyj0q`, validated before the
  staging branch was created
- Cloud processing: disabled by default

The commercial control plane is isolated but not yet serving production traffic:

- Vercel project: `pressay-cloud-production`
- Vercel project ID: `prj_wjK1Ur48HVNXiNwgoPJKilFoCHem`
- Git source: `YoannDrx/pressay-cloud`, production branch `main`
- Runtime contract: Node.js 22 from `package.json`, Hono, region `fra1`
- Neon project: `wandering-boat-94901475`, region `aws-eu-central-1`
- Neon primary branch: `br-square-king-b224neq5`, database `pressay_cloud`
- Pre-schema restore branch: `br-ancient-bird-b2mvkrex`
- Schema: `0014_migrate_legacy_accounts.sql`
- Cloud processing and Stripe commercial launch: disabled

The Vercel project has independent production secrets and is connected to Git.
Its first immutable `main` deployment must pass health, readiness, OAuth and
rollback validation before the production domain is moved.

The existing Vercel project `pressay-api` owns `https://api.press-say.app` and is
outside this repository's deployment flow. Never link, deploy or move that
domain from this checkout until the production cutover gate is approved.

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

Environment variables are encrypted in their respective Vercel projects. At a
minimum, a deploy requires:

- `DATABASE_URL`
- `PRESSAY_DEPLOYMENT_ENV`
- `BETTER_AUTH_SECRET`
- `DEVICE_IDENTIFIER_HMAC_SECRET`
- `RATE_LIMIT_HMAC_SECRET`
- `CRON_SECRET`
- `ENTITLEMENT_SIGNING_PRIVATE_KEY`
- `ENTITLEMENT_SIGNING_KEY_ID`
- `OPENAI_API_KEY`
- `PRESSAY_API_URL`
- `PRESSAY_ALLOWED_ORIGINS`
- `PRESSAY_CLOUD_PROCESSING_ENABLED=false`
- the complete Sign in with Apple credential set used by the Cloud-native flow

Google desktop login is served by the OAuth 2.1 issuer on `press-say.app` and
its credentials belong to `pressay-web`, not this project. Do not duplicate the
Google client secret into Cloud merely to make `/desktop-auth/config` advertise
Google. The staging validator probes the issuer metadata separately.

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
PRESSAY_EXPECTED_CLOUD_AUTH_PROVIDERS=apple bun run validate:staging
```

Before moving the canonical domain, validate the temporary deployment URL while
keeping the configured callback explicit:

```bash
PRESSAY_STAGING_BASE_URL=https://pressay-cloud-staging.vercel.app \
PRESSAY_EXPECTED_AUTH_CALLBACK_URL=https://api-staging.press-say.app/v1/desktop-auth/callback \
PRESSAY_EXPECTED_CLOUD_AUTH_PROVIDERS=apple \
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

## Production cutover gate

Do not move `api.press-say.app` until all of the following are true:

1. the stacked backend pull requests have been reviewed and merged;
2. migrations have passed on a fresh Neon branch and have a production backup
   and rollback decision;
3. Stripe, Apple, email and OAuth production credentials are configured;
4. OpenAI retention wording is published and the Cloud kill switch has passed
   quota, rate-limit and cost-alert tests;
5. account deletion, webhooks, entitlement signing and E2EE recovery pass the
   release matrix;
6. the desktop client uses a configurable staging endpoint and passes its
   offline/local fallback tests;
7. `api.press-say.app` has a documented DNS/domain rollback target.

The cutover is a separate, explicit operation. A staging deployment must never
implicitly reassign the production domain.

Migration `0014_migrate_legacy_accounts.sql` preserves the stable identity subject
and effective legacy entitlement before cutover. It deliberately does not copy
Stripe customer or subscription identifiers because those identifiers belong to
the Stripe account that created them. Reconcile provider records separately against
the dedicated Pressay account before enabling Checkout.
