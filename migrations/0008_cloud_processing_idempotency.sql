ALTER TABLE usage_reservation
  ADD COLUMN request_hash bytea CHECK (request_hash IS NULL OR octet_length(request_hash) = 32),
  ADD COLUMN processing_at timestamptz;

UPDATE usage_reservation
SET request_hash = decode(repeat('00', 32), 'hex')
WHERE request_hash IS NULL;

ALTER TABLE usage_reservation
  ALTER COLUMN request_hash SET NOT NULL;

DROP FUNCTION reserve_pressay_usage(text, uuid, text, integer, text);

CREATE FUNCTION reserve_pressay_usage(
  p_auth_user_id text,
  p_device_id uuid,
  p_kind text,
  p_units integer,
  p_idempotency_key text,
  p_request_hash bytea
)
RETURNS TABLE (
  result_reservation_id uuid,
  result_status text,
  result_units integer,
  result_expires_at timestamptz
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id uuid;
  v_tier text;
  v_valid_until timestamptz;
  v_period_start date := date_trunc('month', now())::date;
  v_limit integer;
  v_used integer;
  v_reserved integer;
  v_existing usage_reservation%ROWTYPE;
  v_reservation usage_reservation%ROWTYPE;
BEGIN
  IF p_kind NOT IN ('cloud_transcription', 'cloud_transformation') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_usage_kind';
  END IF;
  IF p_units <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_usage_units';
  END IF;
  IF p_request_hash IS NULL OR octet_length(p_request_hash) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_request_hash';
  END IF;

  SELECT pa.id, e.tier, e.valid_until
  INTO v_account_id, v_tier, v_valid_until
  FROM pressay_account AS pa
  JOIN entitlement AS e ON e.account_id = pa.id
  WHERE pa.auth_user_id = p_auth_user_id AND pa.status = 'active';

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_not_active';
  END IF;
  IF v_tier <> 'pro' OR v_valid_until IS NULL OR v_valid_until <= now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'cloud_entitlement_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pressay_device AS pd
    WHERE pd.id = p_device_id
      AND pd.account_id = v_account_id
      AND pd.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'device_not_active';
  END IF;

  INSERT INTO usage_period (account_id, period_start)
  VALUES (v_account_id, v_period_start)
  ON CONFLICT (account_id, period_start) DO NOTHING;

  PERFORM 1 FROM usage_period AS up
  WHERE up.account_id = v_account_id AND up.period_start = v_period_start
  FOR UPDATE;

  WITH expired AS (
    UPDATE usage_reservation AS ur
    SET status = 'expired'
    WHERE ur.account_id = v_account_id
      AND ur.period_start = v_period_start
      AND ur.status = 'reserved'
      AND ur.expires_at <= now()
    RETURNING ur.kind, ur.units
  ), totals AS (
    SELECT
      COALESCE(sum(units) FILTER (WHERE kind = 'cloud_transcription'), 0)::integer AS transcription_units,
      COALESCE(sum(units) FILTER (WHERE kind = 'cloud_transformation'), 0)::integer AS transformation_units
    FROM expired
  )
  UPDATE usage_period AS up
  SET
    transcription_seconds_reserved = greatest(
      0,
      up.transcription_seconds_reserved - totals.transcription_units
    ),
    transformations_reserved = greatest(
      0,
      up.transformations_reserved - totals.transformation_units
    ),
    updated_at = now()
  FROM totals
  WHERE up.account_id = v_account_id AND up.period_start = v_period_start;

  SELECT ur.* INTO v_existing
  FROM usage_reservation AS ur
  WHERE ur.account_id = v_account_id AND ur.idempotency_key = p_idempotency_key;

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.device_id <> p_device_id
      OR v_existing.kind <> p_kind
      OR v_existing.units <> p_units
      OR v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'idempotency_conflict';
    END IF;
    RETURN QUERY SELECT
      v_existing.id,
      v_existing.status,
      v_existing.units,
      v_existing.expires_at;
    RETURN;
  END IF;

  SELECT
    CASE
      WHEN p_kind = 'cloud_transcription' THEN limits.cloud_transcription_seconds
      ELSE limits.cloud_transformations
    END,
    CASE
      WHEN p_kind = 'cloud_transcription' THEN up.transcription_seconds_used
      ELSE up.transformations_used
    END,
    CASE
      WHEN p_kind = 'cloud_transcription' THEN up.transcription_seconds_reserved
      ELSE up.transformations_reserved
    END
  INTO v_limit, v_used, v_reserved
  FROM usage_period AS up
  JOIN plan_limit AS limits ON limits.tier = v_tier
  WHERE up.account_id = v_account_id AND up.period_start = v_period_start;

  IF v_used + v_reserved + p_units > v_limit THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'usage_quota_exceeded';
  END IF;

  INSERT INTO usage_reservation (
    account_id,
    device_id,
    period_start,
    kind,
    units,
    idempotency_key,
    request_hash,
    expires_at
  ) VALUES (
    v_account_id,
    p_device_id,
    v_period_start,
    p_kind,
    p_units,
    p_idempotency_key,
    p_request_hash,
    now() + interval '10 minutes'
  )
  RETURNING * INTO v_reservation;

  UPDATE usage_period AS up
  SET
    transcription_seconds_reserved = up.transcription_seconds_reserved
      + CASE WHEN p_kind = 'cloud_transcription' THEN p_units ELSE 0 END,
    transformations_reserved = up.transformations_reserved
      + CASE WHEN p_kind = 'cloud_transformation' THEN p_units ELSE 0 END,
    updated_at = now()
  WHERE up.account_id = v_account_id AND up.period_start = v_period_start;

  RETURN QUERY SELECT
    v_reservation.id,
    v_reservation.status,
    v_reservation.units,
    v_reservation.expires_at;
END;
$$;

CREATE FUNCTION claim_pressay_usage(p_reservation_id uuid)
RETURNS boolean
LANGUAGE sql
AS $$
  WITH claimed AS (
    UPDATE usage_reservation
    SET processing_at = now()
    WHERE id = p_reservation_id
      AND status = 'reserved'
      AND processing_at IS NULL
      AND expires_at > now()
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;
