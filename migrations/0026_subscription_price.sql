-- Commercial metrics: store the price of each subscription as billed, so
-- MRR/ARR use real prices for Stripe and the App Store instead of the
-- catalogue. Stripe processing writes the subscription item's price; Apple
-- processing writes the price of the signed transaction when Apple includes
-- it, otherwise the configured App Store catalogue price. Rows written
-- before this migration stay NULL until their next event; metrics then fall
-- back to the catalogue and count them as estimated.
-- Additive; every statement is idempotent so the file can be replayed safely.

ALTER TABLE billing_subscription
  ADD COLUMN IF NOT EXISTS amount_minor integer
  CHECK (amount_minor IS NULL OR amount_minor >= 0);

ALTER TABLE billing_subscription
  ADD COLUMN IF NOT EXISTS currency text
  CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$');

COMMENT ON COLUMN billing_subscription.amount_minor IS
  'Price per billing interval in minor units (tax included as charged), when known.';
COMMENT ON COLUMN billing_subscription.currency IS
  'ISO 4217 currency of amount_minor, lower case.';
