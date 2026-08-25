# Pressay Cloud deployment

## Environments

The control plane has two isolated canonical deployment targets. Both are live
behind their public API domains, while Cloud processing and commercial Checkout
remain independently fail-closed.

- Vercel project: `pressay-cloud-staging`
- Canonical URL: `https://api-staging.press-say.app`
- Deployment URL: `https://pressay-cloud-staging.vercel.app`
- Runtime: Node.js 22, Hono, region `fra1`
- Database: Neon project `snowy-meadow-52007899`, branch
  `br-old-rain-asfu6s3y`, database `pressay`, schema
  `0015_free_bootstrap_and_web_accounts.sql`
- Branch parent/restore source: `br-plain-sunset-asxlyj0q`, validated before the
  staging branch was created
- Cloud processing: disabled by default

The production control plane is isolated and serves the production API domain:

- Vercel project: `pressay-cloud-production`
- Vercel project ID: `prj_wjK1Ur48HVNXiNwgoPJKilFoCHem`
- Canonical URL: `https://api.press-say.app`
- Git source: `YoannDrx/pressay-cloud`, production branch `main`
- Runtime contract: Node.js 22 from `package.json`, Hono, region `fra1`
- Neon project: `wandering-boat-94901475`, region `aws-eu-central-1`
- Neon primary branch: `br-square-king-b224neq5`, database `pressay_cloud`
- Pre-schema restore branch: `br-ancient-bird-b2mvkrex`
- Schema: `0015_free_bootstrap_and_web_accounts.sql`
- Cloud processing and Stripe commercial launch: disabled

Each Vercel project has independent secrets and is connected to Git. Production
promotion is accepted only from an immutable `main` commit. Domain reassignment
must preserve the previous deployment identifier as a rollback target.

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

Google and Apple desktop login are terminated by Pressay Cloud. Staging and
production use separate OAuth applications, callback URLs and client secrets.
Never copy a provider secret across environments merely to make
`/desktop-auth/config` advertise a provider.

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

App Store verification follows the same boundary: development and staging
accept only Apple Sandbox transactions and notifications; production accepts
only Apple Production payloads. Do not send Sandbox notifications to the
production webhook or Production notifications to staging.

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

Commercial launch additionally requires `STRIPE_TAX_READY=true`,
`STRIPE_AUTOMATIC_TAX_ENABLED=true`, the reviewed Product tax code and Price tax
behavior, and a pinned Customer Portal configuration. These values remain false
or absent until the fiscal decision and Portal legal links are documented. The
catalogue audit also retrieves that exact Portal configuration and rejects it
unless its privacy-policy and terms URLs match the reviewed Pressay pages.

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

## Production promotion gate

Do not promote a new production deployment or enable a commercial kill switch
until all of the following are true:

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

Promotion is a separate, explicit operation. A staging deployment must never
implicitly reassign the production domain.

Migration `0015_free_bootstrap_and_web_accounts.sql` is the current schema head.
Provider customer and subscription identifiers are never copied between Stripe
accounts because those identifiers belong to the account that created them.
Reconcile provider records separately against the dedicated Pressay account
before enabling Checkout.
