# Dedicated Stripe account runbook

This runbook creates Pressay billing in a dedicated Stripe account without
modifying RoutineKids or any other YoDev application. The commercial kill
switch stays disabled throughout provisioning.

## 1. Account boundary

1. In the YoDev Stripe organization, create a new account named `Pressay`.
2. Complete the legal entity, bank account, representative and two-factor
   authentication checks directly in Stripe.
3. Record the account ID (`acct_…`) in the password manager and set it as
   `STRIPE_EXPECTED_ACCOUNT_ID` in the intended environment.
4. Create a restricted test key, then a restricted live key only after the
   observed API calls are known. Never reuse a RoutineKids key.
5. Run `bun run billing:audit`. It must fail before a Pressay catalogue exists
   and must explicitly reject credentials for any other account.

The audit asks Stripe for the account represented by the API key. It does not
look up a connected account by ID, which prevents a Connect relationship from
masking a wrong credential.

## 2. Branding and public information

Configure these items in both test and live settings where Stripe separates
them:

- public identity: `YoDev — Pressay` (while Stripe retains the required legal
  entrepreneur identity for verification and invoices);
- statement descriptor: a compliant Pressay descriptor confirmed in Stripe;
- icon and square logo from the approved Pressay brand pack;
- brand color and accent from the Signal OS design tokens;
- support URL: `https://press-say.app/support`;
- privacy URL: `https://press-say.app/privacy`;
- terms URL: `https://press-say.app/terms`;
- cancellation/refund wording that matches the checkout consent and customer
  portal behavior;
- invoice footer and support email owned by Pressay.

Do not enable Stripe Tax merely to satisfy a technical checklist. Confirm the
legal entity's registrations and the correct software tax code with a qualified
tax adviser first, then test address collection and invoice output.

## 3. Catalogue

With test credentials for the verified Pressay account:

```bash
STRIPE_COMMERCIAL_LAUNCH_ENABLED=false bun run billing:provision
```

The idempotent script creates one active `Pressay Pro` product and only the two
server-owned recurring prices:

- monthly: EUR 7.99;
- annual: EUR 69.00.

Copy the four emitted IDs into the encrypted environment, then run:

```bash
bun run billing:audit
bun run billing:configure
```

The audit verifies exact account, product, currency, amount and interval. A
client never supplies a Price ID.

## 4. Checkout, portal and webhooks

Configure Checkout and the customer portal for plan changes, cancellation,
payment-method updates and invoice access. Register the exact production
webhook endpoint and subscribe only to events the service handles. Rotate the
webhook secret after any endpoint replacement.

Before launch, use Stripe Test Clocks to prove:

- checkout and duplicate submission;
- confirmation that no trial is created by either launch price;
- monthly and annual renewal;
- payment failure, action required and recovery;
- cancel now and cancel at period end;
- upgrade/downgrade policy;
- full and partial refund;
- dispute opened, won and lost;
- customer deletion and webhook replay.

Keep `STRIPE_COMMERCIAL_LAUNCH_ENABLED=false` until these scenarios and the
signed entitlement projection pass against a production-shaped database.

## 5. Existing account audit and archive gate

Before archiving any legacy object, export and reconcile counts for customers,
active subscriptions, schedules, invoices, refunds, disputes and attached
payment methods. A paid subscription requires Stripe's supported account
migration process and a destination-ID reconciliation; it must not be recreated
manually.

If and only if the legacy audit proves there are no Pressay customers or paid
objects, archive obsolete Pressay Prices first and the legacy Pressay Product
last. Never archive RoutineKids objects. Store the audit evidence with the
release record.

## 6. Live activation

Repeat catalogue provisioning with the dedicated live key, configure the live
webhook, run `billing:audit`, and perform one private live checkout followed by
an immediate refund. Compare Stripe, database financial events and the signed
entitlement snapshot. Enable the commercial kill switch gradually only after
that reconciliation is exact.
