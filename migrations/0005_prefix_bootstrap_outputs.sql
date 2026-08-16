DROP FUNCTION bootstrap_pressay_account(text, bytea, text, text, text);

CREATE FUNCTION bootstrap_pressay_account(
  p_auth_user_id text,
  p_device_identifier_hash bytea,
  p_display_name text,
  p_app_variant text,
  p_app_version text
)
RETURNS TABLE (
  result_account_id uuid,
  result_account_created boolean,
  result_device_id uuid,
  result_entitlement_tier text,
  result_entitlement_source text,
  result_entitlement_valid_from timestamptz,
  result_entitlement_valid_until timestamptz,
  result_entitlement_offline_grace_until timestamptz,
  result_entitlement_revision bigint
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id uuid;
  v_account_created boolean;
  v_device_id uuid;
  v_existing_revoked_at timestamptz;
BEGIN
  INSERT INTO pressay_account AS pa (auth_user_id)
  VALUES (p_auth_user_id)
  ON CONFLICT (auth_user_id) DO UPDATE SET updated_at = now()
  RETURNING pa.id, (xmax = 0) INTO v_account_id, v_account_created;

  IF (SELECT pa.status FROM pressay_account AS pa WHERE pa.id = v_account_id) <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_not_active';
  END IF;

  IF v_account_created THEN
    INSERT INTO entitlement (
      account_id,
      tier,
      source,
      valid_from,
      valid_until,
      offline_grace_until
    ) VALUES (
      v_account_id,
      'pro',
      'trial',
      now(),
      now() + interval '14 days',
      now() + interval '14 days 72 hours'
    );
  ELSE
    INSERT INTO entitlement (account_id)
    VALUES (v_account_id)
    ON CONFLICT (account_id) DO NOTHING;
  END IF;

  SELECT pd.id, pd.revoked_at
  INTO v_device_id, v_existing_revoked_at
  FROM pressay_device AS pd
  WHERE pd.account_id = v_account_id
    AND pd.device_identifier_hash = p_device_identifier_hash;

  IF v_device_id IS NOT NULL AND v_existing_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'device_revoked';
  END IF;

  IF v_device_id IS NULL AND (
    SELECT count(*) FROM pressay_device AS pd
    WHERE pd.account_id = v_account_id AND pd.revoked_at IS NULL
  ) >= 3 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'device_limit_reached';
  END IF;

  INSERT INTO pressay_device AS pd (
    account_id,
    device_identifier_hash,
    display_name,
    app_variant,
    app_version
  ) VALUES (
    v_account_id,
    p_device_identifier_hash,
    p_display_name,
    p_app_variant,
    p_app_version
  )
  ON CONFLICT (account_id, device_identifier_hash) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    app_variant = EXCLUDED.app_variant,
    app_version = EXCLUDED.app_version,
    last_seen_at = now()
  RETURNING pd.id INTO v_device_id;

  RETURN QUERY
  SELECT
    v_account_id,
    v_account_created,
    v_device_id,
    e.tier,
    e.source,
    e.valid_from,
    e.valid_until,
    e.offline_grace_until,
    e.revision
  FROM entitlement AS e
  WHERE e.account_id = v_account_id;
END;
$$;
