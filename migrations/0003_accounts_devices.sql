ALTER TABLE entitlement DROP CONSTRAINT entitlement_source_check;
ALTER TABLE entitlement ADD CONSTRAINT entitlement_source_check
  CHECK (source IN ('none', 'trial', 'stripe', 'app_store', 'support'));

CREATE OR REPLACE FUNCTION bootstrap_pressay_account(
  p_auth_user_id text,
  p_device_identifier_hash bytea,
  p_display_name text,
  p_app_variant text,
  p_app_version text
)
RETURNS TABLE (
  account_id uuid,
  account_created boolean,
  device_id uuid,
  entitlement_tier text,
  entitlement_source text,
  entitlement_valid_from timestamptz,
  entitlement_valid_until timestamptz,
  entitlement_offline_grace_until timestamptz,
  entitlement_revision bigint
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id uuid;
  v_account_created boolean;
  v_device_id uuid;
  v_existing_revoked_at timestamptz;
BEGIN
  INSERT INTO pressay_account (auth_user_id)
  VALUES (p_auth_user_id)
  ON CONFLICT (auth_user_id) DO UPDATE SET updated_at = now()
  RETURNING id, (xmax = 0) INTO v_account_id, v_account_created;

  IF (SELECT status FROM pressay_account WHERE id = v_account_id) <> 'active' THEN
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

  SELECT id, revoked_at
  INTO v_device_id, v_existing_revoked_at
  FROM pressay_device
  WHERE account_id = v_account_id
    AND device_identifier_hash = p_device_identifier_hash;

  IF v_device_id IS NOT NULL AND v_existing_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'device_revoked';
  END IF;

  IF v_device_id IS NULL AND (
    SELECT count(*) FROM pressay_device
    WHERE account_id = v_account_id AND revoked_at IS NULL
  ) >= 3 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'device_limit_reached';
  END IF;

  INSERT INTO pressay_device (
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
  RETURNING id INTO v_device_id;

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
  FROM entitlement e
  WHERE e.account_id = v_account_id;
END;
$$;

CREATE OR REPLACE FUNCTION request_pressay_account_deletion(p_auth_user_id text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id uuid;
BEGIN
  UPDATE pressay_account
  SET
    status = 'deleting',
    deletion_requested_at = COALESCE(deletion_requested_at, now()),
    updated_at = now()
  WHERE auth_user_id = p_auth_user_id AND status <> 'deleted'
  RETURNING id INTO v_account_id;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_not_found';
  END IF;

  UPDATE pressay_device
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE account_id = v_account_id;

  DELETE FROM sync_change WHERE account_id = v_account_id;
  DELETE FROM account_recovery_code WHERE account_id = v_account_id;

  INSERT INTO account_deletion_job (account_id)
  VALUES (v_account_id)
  ON CONFLICT (account_id) DO UPDATE SET
    state = CASE
      WHEN account_deletion_job.state = 'completed' THEN 'completed'
      ELSE 'queued'
    END,
    next_attempt_at = now();

  RETURN v_account_id;
END;
$$;
