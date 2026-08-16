# Data model

The database is separated into four bounded areas.

## Identity and devices

Better Auth owns `user`, `session`, `account` and `verification`. The Pressay
domain points to the opaque Better Auth user ID through `pressay_account`.
Devices are identified by a server-keyed hash; the raw machine identifier is not
stored. Approved devices may hold a public key and an encrypted account-key
envelope, never a private key.

## Billing and entitlements

Stripe and App Store subscriptions are normalized in `billing_subscription`.
`provider_event_occurred_at` prevents an older out-of-order webhook from
overwriting newer state. `entitlement` is the materialized server decision used
to sign a short-lived desktop snapshot. Price identifiers live in
`billing_product` and are never accepted from clients.

## Usage

Usage is reserved before a provider request and either finalized or released.
Counters separate used and reserved units to prevent concurrent requests from
overspending a quota. Transcription is counted in seconds; the Pro default is
36,000 seconds (600 minutes) and 2,000 transformations per calendar month.

## E2EE sync

`sync_change` is an append-only cursor stream of opaque versioned envelopes.
Allowed object classes are mode, profile, dictionary and explicitly permitted
preferences. History, transcripts, selected text, audio and BYOK credentials do
not have a schema path and cannot be synchronized accidentally.
