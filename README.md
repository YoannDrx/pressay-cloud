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

## Database changes

SQL migrations in `migrations/` are immutable after deployment. The migration
runner holds a Postgres advisory lock, executes each pending migration in a
transaction and records its SHA-256 checksum. A changed migration is rejected.

Production migrations are prepared and verified on a Neon branch before they
are applied to the production branch.

## Verification

```bash
bun run ci:source
bun run db:migrate
bun run db:migrate # proves checksum validation and idempotency
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
- Store only opaque encrypted sync envelopes; the service never receives the
  account encryption key.

See [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
