-- Subscription status history, for churn, conversion and trial metrics.
-- One row per status change of a billing_subscription row: its creation
-- (from_status NULL) and every later change of status. A trigger records
-- them, so every writer is covered: Stripe and App Store projections
-- (applyStripeSubscription, applyAppleSubscription), the Stripe invoice
-- path that moves a subscription to past_due, and replays.
-- Rows hold statuses and dates only: no amount, no provider identifier, no
-- personal data. They are removed with the subscription when the account is
-- erased (complete_pressay_account_deletion deletes billing_subscription).
-- Existing subscriptions get one backfilled row with their current status at
-- the time of their last provider event; earlier history is unknown.
-- Additive; every statement is idempotent so the file can be replayed safely.

CREATE TABLE IF NOT EXISTS billing_subscription_transition (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id uuid NOT NULL
    REFERENCES billing_subscription (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES pressay_account (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe', 'app_store')),
  environment text NOT NULL CHECK (environment IN ('Production', 'Sandbox')),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  from_status text,
  to_status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  backfilled boolean NOT NULL DEFAULT false,
  CHECK (from_status IS DISTINCT FROM to_status)
);

CREATE INDEX IF NOT EXISTS billing_subscription_transition_subscription_idx
  ON billing_subscription_transition (subscription_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS billing_subscription_transition_occurred_idx
  ON billing_subscription_transition (occurred_at);

CREATE INDEX IF NOT EXISTS billing_subscription_transition_account_idx
  ON billing_subscription_transition (account_id);

COMMENT ON TABLE billing_subscription_transition IS
  'Status changes of billing_subscription (trigger-written); statuses and dates only.';
COMMENT ON COLUMN billing_subscription_transition.occurred_at IS
  'Provider event time of the change (billing_subscription.provider_event_occurred_at).';
COMMENT ON COLUMN billing_subscription_transition.backfilled IS
  'Status found when the history started (migration 0028), not an observed change.';

CREATE OR REPLACE FUNCTION record_pressay_subscription_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;
  INSERT INTO billing_subscription_transition (
    subscription_id, account_id, provider, environment, billing_interval,
    from_status, to_status, occurred_at
  ) VALUES (
    NEW.id, NEW.account_id, NEW.provider, NEW.apple_environment, NEW.billing_interval,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
    NEW.provider_event_occurred_at
  );
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS billing_subscription_transition_trigger
  ON billing_subscription;

CREATE TRIGGER billing_subscription_transition_trigger
  AFTER INSERT OR UPDATE OF status ON billing_subscription
  FOR EACH ROW EXECUTE FUNCTION record_pressay_subscription_transition();

INSERT INTO billing_subscription_transition (
  subscription_id, account_id, provider, environment, billing_interval,
  from_status, to_status, occurred_at, backfilled
)
SELECT
  subscription.id, subscription.account_id, subscription.provider,
  subscription.apple_environment, subscription.billing_interval,
  NULL, subscription.status, subscription.provider_event_occurred_at, true
FROM billing_subscription subscription
WHERE NOT EXISTS (
  SELECT 1 FROM billing_subscription_transition transition
  WHERE transition.subscription_id = subscription.id
);
