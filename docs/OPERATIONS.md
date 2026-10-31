# Pressay Cloud operations runbook

This runbook covers production recovery without handling dictation content or
copying secrets into local files. Every incident record must contain the UTC
time, deployed commit, environment, operator, redacted evidence and rollback
decision.

## Safety rules

- Keep local dictation available. Cloud, sync and checkout kill switches may be
  closed independently.
- Never paste credentials, authorization headers, webhook bodies, transaction
  payloads or customer identifiers into tickets, chat, shell history or logs.
- Use Vercel's protected environment and `vercel curl`; do not download
  write-only variables to diagnose production.
- Take a Neon restore point before a migration or destructive reconciliation.
- A browser redirect never proves payment. Stripe or Apple server projection is
  authoritative.

## Initial triage

1. Record `/v1/health` and `/v1/ready` through the protected deployment URL.
2. Record the immutable Vercel deployment ID and `VERCEL_GIT_COMMIT_SHA`.
3. Check whether the failure affects local dictation, identity, sync, Cloud
   processing, billing projection or only the public website.
4. Close the narrowest relevant kill switch. Keep
   `STRIPE_COMMERCIAL_LAUNCH_ENABLED=false` unless the billing matrix is green.
5. Preserve only redacted counts, error codes and timestamps.

## Vercel or DNS rollback

1. Do not rebuild. Select the last immutable deployment whose commit and schema
   are recorded in the release candidate.
2. Confirm that its environment manifest points to the intended project and
   database.
3. Promote that deployment in the same Vercel project.
4. If the custom domain itself was moved, restore the previously recorded
   domain assignment for `api.press-say.app`.
5. Re-run health, readiness, OAuth metadata, unauthenticated 401 checks and
   `bun run validate:staging` against the restored target.
6. Keep the failed deployment available for redacted logs until the incident is
   understood.

Never move the production domain to `pressay-cloud-staging`; the project-ID
guard intentionally rejects that graph.

## Neon recovery

1. Stop commercial rollout and Cloud processing. Do not run another migration.
2. Identify the restore point recorded before the failed migration.
3. Create a recovery branch from that point and run `bun run db:check` plus the
   complete Cloud verification suite against it.
4. Deploy the application to a protected temporary URL with the recovery branch.
5. Validate health, readiness, auth boundaries, deletion jobs, entitlement
   projection and sync metadata.
6. Promote or repoint only after a second operator review. Preserve the failed
   branch for diagnosis.

## Key rotation

Rotate one trust boundary at a time:

1. Create the replacement in the owning provider.
2. Add it to the correct staging or production Vercel project.
3. Deploy and validate with the old key still valid when the provider supports
   overlap.
4. Revoke the old credential.
5. Re-run `bun run secrets:check`, auth metadata, webhook verification and the
   relevant smoke test.
6. Record only provider key IDs or fingerprints, never secret values.

Entitlement signing rotation requires publishing the new public key before
issuing tokens with it and retaining the prior public key for the maximum token
lifetime plus offline grace.

## OAuth outage

- Existing local dictation remains available and an incoherent partial session
  is discarded.
- Verify issuer, audience, callback and PKCE metadata before changing provider
  configuration.
- Test a new login, expired code, replay and revoked session on staging.
- If the provider is unavailable, communicate the outage without enabling an
  alternate silent identity or Cloud route.

## Stripe webhook or entitlement incident

1. Close checkout. Do not revoke local Free capabilities.
2. Inspect aggregate webhook outcomes and pending provider-event counts.
3. Verify the endpoint secret and raw-body signature path in the intended mode.
4. Replay only provider events whose IDs and catalogue membership have been
   reconciled. Processing is idempotent and must tolerate out-of-order delivery.
5. Compare Stripe subscription state, SQL projection and the newly signed
   entitlement before reopening checkout.
6. For a refund or dispute, confirm that only the relevant commercial right is
   withdrawn and that another valid provider subscription is preserved.

Never repair a right by editing the client or trusting a success URL.

## App Store notification incident

1. Keep the MAS purchase surface closed if server reconciliation is unhealthy.
2. Confirm both Apple environments reach the backend used by the tested build. Production-backed App Review needs Sandbox notifications at production; never send Production payloads to staging.
3. Verify the notification JWS against Apple roots and reconcile the original
   transaction through App Store Server API.
4. Test duplicate, delayed, refund, revocation and restore paths before
   reopening the StoreKit surface.

## Account deletion backlog

1. Run the authenticated internal job or `bun run jobs:account-deletions` in the
   intended protected environment.
2. Observe only `claimed`, `completed` and `failed` counts.
3. If failures persist, keep access revoked and investigate the aggregate error
   code. Never re-enable sync or entitlements to unblock deletion.
4. After provider recovery, rerun the idempotent batch and confirm the backlog
   returns to zero.

## Privacy incident

1. Disable the affected remote route and preserve access logs under restricted
   retention.
2. Rotate exposed credentials and invalidate affected sessions.
3. Determine data classes, time window and affected systems without copying
   content into the incident record.
4. Follow the legal notification procedure and support script approved for
   Pressay.
5. Add a redaction regression test before re-enabling the route.

## Administrator access recovery

Administrators are `operations_member` rows (`owner`, `support`,
`readonly`); every one needs an Authenticator app on their web account. Check
`member.*` entries in the audit log after any of these steps.

1. **A member lost their Authenticator app.** They sign in and use a backup
   code from `/account/security` to enroll a new app. Without backup codes,
   another owner removes them from `/admin/team`; the web identity's second
   factor is then reset by an operator on the web database (remove the
   person's `auth_two_factors` row and set `"twoFactorEnabled"` to false), the
   person enrolls again and an owner adds them back.
2. **No active owner is left** (the last owner's account was deleted). Add a
   verified address you control to `PRESSAY_OPERATIONS_OWNER_EMAILS` in the
   production environment and redeploy. Sign in on the site with that
   address, enroll an Authenticator app, open `/admin`: the account becomes
   owner (`member.owner.claimed`, alert sent). Remove the address from the
   variable afterwards if it should not stay a recovery address.
3. **The only owner is locked out but their account still exists.** Prefer
   step 1 for that person. Otherwise, from a reviewed database session with a
   restore point, demote them so step 2 applies:
   `UPDATE operations_member SET role = 'readonly', updated_at = now() WHERE account_id = '<account id>';`
4. **A member's account is compromised.** An owner removes the member in
   `/admin/team`, then uses "Déconnecter partout" on that person's customer
   record. If no owner can sign in, delete the row
   (`DELETE FROM operations_member WHERE account_id = '<account id>';`) and
   follow step 2.

Never share a session or an Authenticator seed between people: add each
person with their own account and the least role they need.

## Release and recovery evidence

An incident or release gate is closed only when the register contains:

- app, Cloud and web commits;
- Vercel deployment and schema version;
- Stripe and StoreKit catalogue revisions when applicable;
- redacted automated and native test results;
- the rollback target and proof that it was exercised;
- remaining limitations and the explicit operator decision.
