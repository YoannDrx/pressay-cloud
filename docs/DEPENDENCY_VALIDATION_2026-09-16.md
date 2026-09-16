# Dependency validation — 16 September 2026

This integrates the compatible updates proposed by Dependabot PRs 38 and 39 and regenerates the Bun lockfile, which those PRs had left unchanged. Runtime versions include Better Auth 1.7.3, Hono 4.13.7, Stripe 22.6.1 and Zod 4.5.4.

Stripe requests explicitly use 2026-08-26.dahlia, matching the SDK types. The [official changelog](https://docs.stripe.com/changelog) lists the changes from 2026-07-29.dahlia as non-breaking. Existing webhook fixtures retain the earlier event API version to verify continued handling. The Stripe account default and webhook endpoint configuration are unchanged.

TypeScript remains 6.0.2: typescript-eslint 8.69.0 explicitly rejects TypeScript 7.0. Node declarations remain 22.19.11 to match the deployed Node 22 runtime. These two proposed major updates are intentionally excluded after validation, rather than suppressing the incompatibility.

Validation: typecheck, ESLint, Prettier, secretlint and dependency audit pass; no advisories found. All 157 tests pass with both PostgreSQL integration suites enabled against an isolated local database (18 database tests). No SQL migration or production business setting changes.
