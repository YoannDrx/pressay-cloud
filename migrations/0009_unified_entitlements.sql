CREATE OR REPLACE FUNCTION recompute_pressay_entitlement(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_source text;
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
    subscription.current_period_ends_at
  INTO v_source, v_valid_from, v_valid_until
  FROM billing_subscription subscription
  WHERE subscription.account_id = p_account_id
    AND subscription.status IN ('trialing', 'active', 'past_due', 'grace')
    AND subscription.current_period_ends_at > now()
  ORDER BY subscription.current_period_ends_at DESC, subscription.provider_event_occurred_at DESC
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
        ELSE v_valid_until + interval '72 hours'
      END
    );

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  RETURN v_row_count > 0;
END;
$$;
