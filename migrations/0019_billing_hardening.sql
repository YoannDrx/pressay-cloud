-- Billing hardening (additive):
-- * past_due no longer grants Pro for a whole new period: access ends at the
--   earlier of the period end and grace_ends_at (set by the service from
--   STRIPE_PAST_DUE_GRACE_DAYS), or 7 days after the period start when unset.
-- * the entitlement records whether its winning source is an Apple Sandbox
--   purchase (App Review / TestFlight), so support and the admin can tell it
--   apart from paid access.

ALTER TABLE billing_subscription
  ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz;

COMMENT ON COLUMN billing_subscription.grace_ends_at IS
  'For past_due subscriptions: the end of the payment-failure grace window.';

ALTER TABLE entitlement
  ADD COLUMN IF NOT EXISTS sandbox boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN entitlement.sandbox IS
  'True when the current Pro source is an Apple Sandbox purchase (never paid).';

CREATE OR REPLACE FUNCTION recompute_pressay_entitlement(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_source text; v_from timestamptz; v_until timestamptz; v_sandbox boolean; v_count integer;
BEGIN
  PERFORM 1 FROM entitlement WHERE account_id=p_account_id FOR UPDATE;
  SELECT source,starts_at,ends_at,sandbox INTO v_source,v_from,v_until,v_sandbox FROM (
    SELECT provider AS source,
      COALESCE(current_period_starts_at,created_at) AS starts_at,
      CASE
        WHEN status='past_due' THEN LEAST(
          current_period_ends_at,
          COALESCE(grace_ends_at, COALESCE(current_period_starts_at,created_at) + interval '7 days')
        )
        ELSE current_period_ends_at
      END AS ends_at,
      apple_environment='Sandbox' AS sandbox
    FROM billing_subscription WHERE account_id=p_account_id
      AND status IN ('trialing','active','past_due','grace')
    UNION ALL
    SELECT 'support',starts_at,ends_at,false FROM access_grant
      WHERE account_id=p_account_id AND revoked_at IS NULL AND starts_at<=now()
  ) candidates
  WHERE ends_at>now()
  ORDER BY sandbox ASC,ends_at DESC,(source IN ('stripe','app_store')) DESC LIMIT 1;
  UPDATE entitlement SET tier=CASE WHEN v_source IS NULL THEN 'free' ELSE 'pro' END,
    source=COALESCE(v_source,'none'),valid_from=COALESCE(v_from,valid_from),valid_until=v_until,
    offline_grace_until=CASE WHEN v_until IS NULL THEN NULL WHEN v_sandbox THEN v_until ELSE v_until+interval '72 hours' END,
    sandbox=COALESCE(v_sandbox,false),
    revision=revision+1,updated_at=now()
  WHERE account_id=p_account_id AND (
    source IS DISTINCT FROM COALESCE(v_source,'none')
    OR valid_until IS DISTINCT FROM v_until
    OR sandbox IS DISTINCT FROM COALESCE(v_sandbox,false)
  );
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count>0;
END $$;

-- Re-project accounts whose access depends on a past_due or Sandbox subscription.
DO $$
DECLARE v_account uuid;
BEGIN
  FOR v_account IN
    SELECT DISTINCT account_id FROM billing_subscription
    WHERE status = 'past_due' OR apple_environment = 'Sandbox'
  LOOP
    PERFORM recompute_pressay_entitlement(v_account);
  END LOOP;
END;
$$;
