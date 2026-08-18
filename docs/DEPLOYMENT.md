# Pressay Cloud deployment

## Environments

The new control plane currently has one safe deployment target:

- Vercel project: `pressay-cloud-staging`
- URL: `https://pressay-cloud-staging.vercel.app`
- Runtime: Node.js 22, Hono, region `fra1`
- Database: Neon branch `br-flat-sun-asxuwkgv`, database `pressay_cloud`
- Cloud processing: disabled by default

The existing Vercel project `pressay-api` owns `https://api.press-say.app` and is
outside this repository's deployment flow. Never link, deploy or move that
domain from this checkout until the production cutover gate is approved.

Git auto-deploy is intentionally not connected yet. Connecting it while the
backend work is still a stack of pull requests could deploy an older default
branch over the verified staging release. Enable it only after the stack is
merged and Preview environment variables point to an isolated Neon branch.

## Required variables

Production variables on the staging project are encrypted in Vercel. At a
minimum, a deploy requires:

- `DATABASE_URL`
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

The staging cron secret also has an operator copy in the macOS Keychain under
service `app.pressay.cloud.cron` and account `pressay-cloud-staging`. Secret
values must never be placed in shell history, GitHub, documentation or logs.

## Deploy and verify

Run the source gate before every deployment:

```bash
bun run ci:source
vercel deploy --prod --yes
vercel curl /v1/health --deployment https://pressay-cloud-staging.vercel.app
vercel curl /v1/ready --deployment https://pressay-cloud-staging.vercel.app
bun run validate:staging
```

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
