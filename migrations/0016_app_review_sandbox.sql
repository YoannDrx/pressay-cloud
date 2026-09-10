-- Preserve existing paid subscriptions; Sandbox IDs are separately namespaced by
-- the service. Apple review runs against the production API with signed test data.
ALTER TABLE billing_subscription
  ADD COLUMN apple_environment text NOT NULL DEFAULT 'Production',
  ADD CONSTRAINT billing_subscription_apple_environment_check CHECK (
    apple_environment = 'Production'
    OR (provider = 'app_store' AND apple_environment = 'Sandbox'
        AND provider_subscription_id LIKE 'sandbox/%')
  );

-- Real subscriptions always take priority. Sandbox access ends at Apple's
-- verified expiry and never receives the 72-hour paid offline grace period.
CREATE OR REPLACE FUNCTION recompute_pressay_entitlement(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_source text;
  v_sandbox boolean;
  v_valid_from timestamptz;
  v_valid_until timestamptz;
  v_current entitlement%ROWTYPE;
  v_row_count integer := 0;
BEGIN
  SELECT * INTO v_current
  FROM entitlement
  WHERE account_id = p_account_id
  FOR UPDATE;

  IF v_current.account_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT
    subscription.provider,
    COALESCE(subscription.current_period_starts_at, subscription.created_at),
    subscription.current_period_ends_at,
    subscription.apple_environment = 'Sandbox'
  INTO v_source, v_valid_from, v_valid_until, v_sandbox
  FROM billing_subscription subscription
  WHERE subscription.account_id = p_account_id
    AND subscription.status IN ('trialing', 'active', 'past_due', 'grace')
    AND subscription.current_period_ends_at > now()
  ORDER BY (subscription.apple_environment = 'Sandbox') ASC, subscription.current_period_ends_at DESC, subscription.provider_event_occurred_at DESC
  LIMIT 1;

  IF v_source IS NULL
    AND v_current.source IN ('trial', 'support')
    AND v_current.valid_until > now() THEN
    RETURN false;
  END IF;

  IF v_source IS NOT NULL
    AND v_current.source = 'support'
    AND v_current.valid_until > v_valid_until THEN
    RETURN false;
  END IF;

  UPDATE entitlement
  SET
    tier = CASE WHEN v_source IS NULL THEN 'free' ELSE 'pro' END,
    source = COALESCE(v_source, 'none'),
    valid_from = COALESCE(v_valid_from, now()),
    valid_until = v_valid_until,
    offline_grace_until = CASE
      WHEN v_valid_until IS NULL THEN NULL
      WHEN v_sandbox THEN v_valid_until
      ELSE v_valid_until + interval '72 hours'
    END,
    revision = revision + 1,
    updated_at = now()
  WHERE account_id = p_account_id
    AND (
      tier IS DISTINCT FROM CASE WHEN v_source IS NULL THEN 'free' ELSE 'pro' END
      OR source IS DISTINCT FROM COALESCE(v_source, 'none')
      OR valid_from IS DISTINCT FROM COALESCE(v_valid_from, valid_from)
      OR valid_until IS DISTINCT FROM v_valid_until
      OR offline_grace_until IS DISTINCT FROM CASE
        WHEN v_valid_until IS NULL THEN NULL
        WHEN v_sandbox THEN v_valid_until
        ELSE v_valid_until + interval '72 hours'
      END
    );

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RETURN v_row_count > 0;
END;
$$;


-- A statement cannot UPDATE a provider_event row inserted by a sibling CTE:
-- both use the same snapshot. Run finalization in a volatile function after the
-- upsert dependency has executed, so its SQL commands see the new rows.
CREATE FUNCTION finalize_pressay_billing_event(
  p_provider text, p_event_id text, p_accounts uuid[],
  p_applied boolean, p_error_code text
) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_account uuid;
  v_state text;
BEGIN
  FOREACH v_account IN ARRAY p_accounts LOOP
    PERFORM recompute_pressay_entitlement(v_account);
  END LOOP;
  UPDATE provider_event
  SET state = CASE WHEN p_applied THEN 'applied' ELSE 'ignored' END,
      error_code = p_error_code, processed_at = now()
  WHERE provider = p_provider AND provider_event_id = p_event_id
    AND state = 'received'
  RETURNING state INTO v_state;
  RETURN COALESCE(v_state, 'ignored');
END;
$$;

-- Repair access for subscriptions previously stored without finalization.
DO $$
DECLARE v_account uuid;
BEGIN
  FOR v_account IN SELECT DISTINCT account_id FROM billing_subscription LOOP
    PERFORM recompute_pressay_entitlement(v_account);
  END LOOP;
END;
$$;
