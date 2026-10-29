-- The desktop app now ships on Windows. Devices record their platform so the
-- account can tell a Mac from a PC; both share the same three Cloud slots.
-- Existing rows and older clients that omit the platform stay 'macos'.
-- Every statement is idempotent so the file can be replayed safely.

ALTER TABLE pressay_device
  DROP CONSTRAINT IF EXISTS pressay_device_platform_check;

ALTER TABLE pressay_device
  ADD CONSTRAINT pressay_device_platform_check
  CHECK (platform IN ('macos', 'windows'));

ALTER TABLE pressay_device
  ALTER COLUMN platform SET DEFAULT 'macos';

-- Drop the five-argument form so a five-argument call cannot be ambiguous
-- with the new signature, whose platform argument defaults to 'macos'.
DROP FUNCTION IF EXISTS bootstrap_pressay_account(text, bytea, text, text, text);

CREATE OR REPLACE FUNCTION bootstrap_pressay_account(
  p_auth_user_id text,
  p_device_identifier_hash bytea,
  p_display_name text,
  p_app_variant text,
  p_app_version text,
  p_platform text DEFAULT 'macos'
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

  INSERT INTO entitlement (account_id)
  VALUES (v_account_id)
  ON CONFLICT (account_id) DO NOTHING;

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
    platform,
    app_variant,
    app_version
  ) VALUES (
    v_account_id,
    p_device_identifier_hash,
    p_display_name,
    COALESCE(p_platform, 'macos'),
    p_app_variant,
    p_app_version
  )
  ON CONFLICT (account_id, device_identifier_hash) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    platform = EXCLUDED.platform,
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

COMMENT ON FUNCTION bootstrap_pressay_account(text, bytea, text, text, text, text) IS
  'Creates or loads a Cloud account and registers a macOS or Windows device within the shared three-device limit.';
