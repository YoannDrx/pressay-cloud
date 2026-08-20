# Pressay Cloud

Private control plane for Pressay accounts, entitlements, billing, usage and
end-to-end encrypted settings sync.

Pressay Cloud never persists dictation text, selected text, prompts, audio or
BYOK credentials. Those fields are also forbidden in application logs.

Cloud processing is opt-in per request. Both endpoints require an authenticated
Pro account, an active device, a unique `Idempotency-Key` header and an explicit
content-transfer acknowledgement:

- `POST /v1/cloud/transformations` uses the server alias
  `pressay-transform-v1` with response storage disabled.
- `POST /v1/cloud/transcriptions` accepts validated 16-bit PCM WAV audio up to
  4 MB and 180 seconds. The stricter file limit stays below Vercel's 4.5 MB
  request limit; longer recordings remain local.

Quota is reserved and claimed atomically before a provider call. The request
hash detects idempotency-key misuse without retaining the request body. A failed
provider call releases the reservation; a completed or in-flight key is never
sent to the provider twice.

Cloud processing also has a server-side kill switch and independent per-minute
limits for account, device and IP. Rate-limit identifiers are HMAC-hashed before
they reach Postgres, and expired buckets are removed by daily maintenance.

App Store purchases use StoreKit 2 signed transactions. The restore endpoint
requires the transaction `appAccountToken` to equal the authenticated Pressay
account UUID, then refreshes status through the App Store Server API. Version 2
notifications are verified against Apple's published roots before they update
billing state. Stripe and Apple subscriptions are projected through one
entitlement recomputation function, so an expired provider cannot revoke another
provider's still-current entitlement.

## Runtime

- Node.js 22
- Hono on Vercel Functions
- Neon Postgres in the EU
- Better Auth
- Apple App Store Server Library
- Zod contracts
- Vitest

## Local setup

```bash
cp .env.example .env.local
bun install --frozen-lockfile
bun run db:migrate
bun run dev
```

The API is served on `http://localhost:3000`. `GET /v1/health` is process-only;
`GET /v1/ready` verifies the database connection.

Set `PRESSAY_CLOUD_PROCESSING_ENABLED=true` only after provider retention,
budget alerts and the deployment environment have passed the release gate. It
defaults to `false`.

## Operational jobs

`DELETE /v1/me` immediately revokes Cloud access, removes E2EE sync material and
queues deletion of the remaining provider and local identity records. The daily
Vercel cron calls `GET /v1/internal/jobs/account-deletions`; Vercel authenticates
that request with `Authorization: Bearer <CRON_SECRET>`. Use an independent,
random `CRON_SECRET` of at least 32 characters. The worker claims jobs with
`FOR UPDATE SKIP LOCKED`, retries provider failures with bounded backoff and
never persists provider error messages.

The Hobby-compatible schedule runs once daily, so final provider deletion may
take up to 24 hours after access and synchronized material have been revoked.
For manual recovery from an operational incident, run:

```bash
bun run jobs:account-deletions
```

The command emits counts and event names only; it never logs account identifiers
or provider payloads.

## Database changes

SQL migrations in `migrations/` are immutable after deployment. The migration
runner holds a Postgres advisory lock, executes each pending migration in a
transaction and records its SHA-256 checksum. A changed migration is rejected.

Production migrations are prepared and verified on a Neon branch before they
are applied to the production branch. Vercel builds never mutate the database:
an operator runs `bun run release:prepare` against the intended environment,
records the Neon restore point, and only then promotes a deployment. Production
builds are rejected unless Vercel identifies an immutable commit from `main`.

## Verification

```bash
bun run ci:source
bun run db:migrate
bun run db:migrate # proves checksum validation and idempotency
bun run db:check
bun run billing:configure:app-store
```

GitHub-hosted Actions are intentionally not required: this private repository is
operated without a paid GitHub plan, and the account currently cannot allocate a
hosted runner. GitGuardian still scans pull requests; source gates run locally
and deployment gates run in Vercel. A self-hosted or hosted workflow can be added
later without changing the verification commands.

## Security invariants

- Never log request or response bodies.
- Never log authorization, cookies, text, audio, clipboard, prompts or API keys.
- Never accept Stripe Price IDs from a client.
- Verify Stripe and Apple webhook signatures from their unmodified request body.
- Require an idempotency key before every billable operation.
- Require an explicit transfer acknowledgement before Cloud content leaves the
  device.
- Keep Cloud processing disabled by default and hash all rate-limit identifiers.
- Authenticate every maintenance invocation with Vercel's `CRON_SECRET`.
- Store only opaque encrypted sync envelopes; the service never receives the
  account encryption key.

See [SECURITY.md](SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
