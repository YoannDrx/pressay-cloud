# Pressay Cloud

Private control plane for Pressay accounts, entitlements, billing, usage and
end-to-end encrypted settings sync.

Pressay Cloud never persists dictation text, selected text, prompts, audio or
BYOK credentials. Those fields are also forbidden in application logs.

## Runtime

- Node.js 22
- Hono on Vercel Functions
- Neon Postgres in the EU
- Better Auth
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

## Security invariants

- Never log request or response bodies.
- Never log authorization, cookies, text, audio, clipboard, prompts or API keys.
- Never accept Stripe Price IDs from a client.
- Verify Stripe and Apple webhook signatures from their unmodified request body.
- Require an idempotency key before every billable operation.
- Store only opaque encrypted sync envelopes; the service never receives the
  account encryption key.

See [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
