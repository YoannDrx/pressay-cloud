-- Billing visibility: link each provider event to the Pressay account it
-- concerns, so support sees failed webhooks per customer and can replay them.
-- Stripe and Apple processing fill the column from now on; events that
-- already wrote a financial ledger row are attached to that row's account.
-- Additive; every statement is idempotent so the file can be replayed safely.

ALTER TABLE provider_event
  ADD COLUMN IF NOT EXISTS account_id uuid
  REFERENCES pressay_account (id) ON DELETE SET NULL;

COMMENT ON COLUMN provider_event.account_id IS
  'Account the event was applied to, when known; NULL for unmatched events.';

CREATE INDEX IF NOT EXISTS provider_event_account_idx
  ON provider_event (account_id, received_at DESC)
  WHERE account_id IS NOT NULL;

-- Failed events are listed and counted by the admin and the daily digest.
CREATE INDEX IF NOT EXISTS provider_event_failed_idx
  ON provider_event (received_at DESC)
  WHERE state = 'failed';

UPDATE provider_event event
SET account_id = financial.account_id
FROM billing_financial_event financial
WHERE event.account_id IS NULL
  AND financial.account_id IS NOT NULL
  AND financial.provider = event.provider
  AND financial.provider_event_id = event.provider_event_id;
