-- Support actions from the administration: offer or extend Pro, revoke or
-- restore a device, and a structured audit trail for them.
-- Additive: existing rows, functions and callers keep working unchanged.
-- Every statement is idempotent so the file can be replayed safely.

-- 1. Pro offered directly by support, with the reason and the author.
ALTER TABLE access_grant
  DROP CONSTRAINT IF EXISTS access_grant_source_check;

ALTER TABLE access_grant
  ADD CONSTRAINT access_grant_source_check
  CHECK (source IN ('invitation', 'referral', 'legacy', 'support'));

ALTER TABLE access_grant
  ADD COLUMN IF NOT EXISTS reason text
  CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500);

ALTER TABLE access_grant
  ADD COLUMN IF NOT EXISTS created_by uuid
  REFERENCES pressay_account (id) ON DELETE SET NULL;

COMMENT ON COLUMN access_grant.reason IS
  'Administrator reason for a support grant; never customer-provided text.';

-- 2. Audit entries name the account they concern and carry structured
-- details (identifiers, durations, counts). Details never hold personal data:
-- no email, no name, no customer-provided text.
ALTER TABLE operations_audit
  ADD COLUMN IF NOT EXISTS target_account_id uuid;

ALTER TABLE operations_audit
  ADD COLUMN IF NOT EXISTS details jsonb;

ALTER TABLE operations_audit
  DROP CONSTRAINT IF EXISTS operations_audit_details_check;

ALTER TABLE operations_audit
  ADD CONSTRAINT operations_audit_details_check
  CHECK (
    details IS NULL
    OR (jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 2048)
  );

COMMENT ON COLUMN operations_audit.target_account_id IS
  'Account concerned by the entry; no foreign key so the ledger outlives it.';
COMMENT ON COLUMN operations_audit.details IS
  'Structured, non-personal details: identifiers, durations, counts.';

CREATE INDEX IF NOT EXISTS operations_audit_target_account_idx
  ON operations_audit (target_account_id, id DESC)
  WHERE target_account_id IS NOT NULL;

-- Earlier entries targeted an account or a grant by its identifier as text.
-- CASE keeps the uuid cast away from non-uuid targets.
UPDATE operations_audit audit
SET target_account_id = account.id
FROM pressay_account account
WHERE audit.target_account_id IS NULL
  AND account.id = CASE
    WHEN audit.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN audit.target_id::uuid
  END;

UPDATE operations_audit audit
SET target_account_id = grant_row.account_id
FROM access_grant grant_row
WHERE audit.target_account_id IS NULL
  AND grant_row.id = CASE
    WHEN audit.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN audit.target_id::uuid
  END;

-- 3. Idempotency of administrative actions. The form's key is claimed in the
-- same transaction as the action, so a failed action leaves the key free and
-- a replayed key returns the first result without acting twice. Rows hold no
-- personal data and are purged by the retention job.
CREATE TABLE IF NOT EXISTS operations_request (
  request_key uuid NOT NULL,
  action text NOT NULL,
  target_id text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_key, action)
);

CREATE INDEX IF NOT EXISTS operations_request_created_idx
  ON operations_request (created_at);

COMMENT ON TABLE operations_request IS
  'Idempotency keys of administrative actions; transient, no personal data.';

-- Returns the stored result when the key was already used for this action,
-- NULL when the caller now owns the key. A key reused on another target is
-- refused.
CREATE OR REPLACE FUNCTION claim_pressay_operations_request(
  p_key uuid,
  p_action text,
  p_target text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_target text;
  v_result jsonb;
BEGIN
  INSERT INTO operations_request (request_key, action, target_id)
  VALUES (p_key, p_action, p_target)
  ON CONFLICT DO NOTHING;
  IF FOUND THEN
    RETURN NULL;
  END IF;
  SELECT target_id, result INTO v_target, v_result
  FROM operations_request
  WHERE request_key = p_key AND action = p_action;
  IF v_target IS DISTINCT FROM p_target THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'request_key_reused';
  END IF;
  RETURN v_result || jsonb_build_object('replayed', true);
END $$;

-- Offer Pro for p_days from now. Paid subscriptions are untouched: the
-- entitlement keeps whichever source lasts longest.
CREATE OR REPLACE FUNCTION grant_pressay_support_access(
  p_account uuid,
  p_days integer,
  p_reason text,
  p_actor uuid,
  p_request uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb;
  v_grant uuid;
  v_end timestamptz;
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_duration';
  END IF;
  v_result := claim_pressay_operations_request(p_request, 'grant.create', p_account::text);
  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;
  PERFORM 1 FROM pressay_account WHERE id = p_account AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_not_active';
  END IF;
  INSERT INTO entitlement (account_id) VALUES (p_account) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM entitlement WHERE account_id = p_account FOR UPDATE;
  INSERT INTO access_grant (account_id, source, ends_at, reason, created_by)
  VALUES (p_account, 'support', now() + make_interval(days => p_days), p_reason, p_actor)
  RETURNING id, ends_at INTO v_grant, v_end;
  PERFORM recompute_pressay_entitlement(p_account);
  v_result := jsonb_build_object(
    'grantId', v_grant,
    'accountId', p_account,
    'days', p_days,
    'endsAt', v_end
  );
  UPDATE operations_request SET result = v_result
  WHERE request_key = p_request AND action = 'grant.create';
  RETURN v_result;
END $$;

-- Extend a non-revoked grant by p_days from its end, or from now when it has
-- already ended.
CREATE OR REPLACE FUNCTION extend_pressay_grant(
  p_grant uuid,
  p_days integer,
  p_request uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb;
  v_account uuid;
  v_end timestamptz;
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 365 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_duration';
  END IF;
  v_result := claim_pressay_operations_request(p_request, 'grant.extend', p_grant::text);
  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;
  SELECT account_id INTO v_account FROM access_grant WHERE id = p_grant;
  IF v_account IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'grant_not_found';
  END IF;
  PERFORM 1 FROM pressay_account WHERE id = v_account AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_not_active';
  END IF;
  PERFORM 1 FROM entitlement WHERE account_id = v_account FOR UPDATE;
  UPDATE access_grant
  SET ends_at = greatest(ends_at, now()) + make_interval(days => p_days)
  WHERE id = p_grant AND revoked_at IS NULL
  RETURNING ends_at INTO v_end;
  IF v_end IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'grant_revoked';
  END IF;
  PERFORM recompute_pressay_entitlement(v_account);
  v_result := jsonb_build_object(
    'grantId', p_grant,
    'accountId', v_account,
    'days', p_days,
    'endsAt', v_end
  );
  UPDATE operations_request SET result = v_result
  WHERE request_key = p_request AND action = 'grant.extend';
  RETURN v_result;
END $$;

-- Lift a device revocation within the shared three-device limit. The account
-- row is locked like bootstrap_pressay_account does, so a restore and a new
-- sign-in cannot both take the last slot. p_auth_user_id restricts the call
-- to the owner's own devices (NULL for support); p_request is optional.
CREATE OR REPLACE FUNCTION restore_pressay_device(
  p_device uuid,
  p_auth_user_id text,
  p_request uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb;
  v_account uuid;
  v_subject text;
  v_status text;
  v_revoked timestamptz;
  v_platform text;
BEGIN
  IF p_request IS NOT NULL THEN
    v_result := claim_pressay_operations_request(p_request, 'device.restore', p_device::text);
    IF v_result IS NOT NULL THEN
      RETURN v_result;
    END IF;
  END IF;
  SELECT account_id INTO v_account FROM pressay_device WHERE id = p_device;
  IF v_account IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'device_not_found';
  END IF;
  SELECT auth_user_id, status INTO v_subject, v_status
  FROM pressay_account WHERE id = v_account FOR UPDATE;
  IF p_auth_user_id IS NOT NULL AND v_subject IS DISTINCT FROM p_auth_user_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'device_not_found';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_not_active';
  END IF;
  SELECT revoked_at, platform INTO v_revoked, v_platform
  FROM pressay_device WHERE id = p_device FOR UPDATE;
  IF v_revoked IS NOT NULL THEN
    IF (
      SELECT count(*) FROM pressay_device
      WHERE account_id = v_account AND revoked_at IS NULL
    ) >= 3 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'device_limit_reached';
    END IF;
    UPDATE pressay_device SET revoked_at = NULL WHERE id = p_device;
  END IF;
  v_result := jsonb_build_object(
    'deviceId', p_device,
    'accountId', v_account,
    'platform', v_platform,
    'restored', v_revoked IS NOT NULL
  );
  IF p_request IS NOT NULL THEN
    UPDATE operations_request SET result = v_result
    WHERE request_key = p_request AND action = 'device.restore';
  END IF;
  RETURN v_result;
END $$;
