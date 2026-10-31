-- Several administrators with a role, instead of a single operations owner.
--   owner    everything, including billing actions and the member list;
--   support  support actions (grants, devices, deletions, invitations,
--            sign-out everywhere, access-request exports), no billing, no roles;
--   readonly reads only.
-- The current owner becomes an `owner` member: nobody loses access.
-- operations_owner is left in place, unused by the new code, so the code
-- running before this release keeps working once the migration is applied;
-- a later migration can drop it.
-- Additive; every statement is idempotent so the file can be replayed safely.

CREATE TABLE IF NOT EXISTS operations_member (
  account_id uuid PRIMARY KEY REFERENCES pressay_account (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'support', 'readonly')),
  added_by uuid REFERENCES pressay_account (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operations_member_role_idx
  ON operations_member (role);

COMMENT ON TABLE operations_member IS
  'Administrators and their role (owner, support, readonly).';

INSERT INTO operations_member (account_id, role)
SELECT account_id, 'owner' FROM operations_owner WHERE account_id IS NOT NULL
ON CONFLICT (account_id) DO NOTHING;

-- Add, change (p_role) or remove (p_role NULL) a member. Only an owner may
-- call it, and the last active owner can be neither demoted nor removed.
-- Owner rows are locked first, so two concurrent changes cannot both remove
-- the last owner. p_request is the form's idempotency key.
CREATE OR REPLACE FUNCTION set_pressay_operations_member(
  p_actor uuid,
  p_account uuid,
  p_role text,
  p_request uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb;
  v_previous text;
  v_owners integer;
BEGIN
  IF p_role IS NOT NULL AND p_role NOT IN ('owner', 'support', 'readonly') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_role';
  END IF;
  v_result := claim_pressay_operations_request(
    p_request, 'member.set', p_account::text || '/' || COALESCE(p_role, 'none')
  );
  IF v_result IS NOT NULL THEN
    RETURN v_result;
  END IF;
  PERFORM 1 FROM operations_member WHERE role = 'owner' ORDER BY account_id FOR UPDATE;
  PERFORM 1 FROM operations_member member
  JOIN pressay_account account ON account.id = member.account_id
  WHERE member.account_id = p_actor AND member.role = 'owner'
    AND account.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'owner_required';
  END IF;
  SELECT role INTO v_previous FROM operations_member WHERE account_id = p_account FOR UPDATE;
  IF p_role IS NOT NULL THEN
    PERFORM 1 FROM pressay_account account
    JOIN account_contact contact ON contact.account_id = account.id
    WHERE account.id = p_account AND account.status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account_not_active';
    END IF;
  ELSIF v_previous IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'member_not_found';
  END IF;
  IF v_previous = 'owner' AND p_role IS DISTINCT FROM 'owner' THEN
    SELECT count(*) INTO v_owners FROM operations_member member
    JOIN pressay_account account ON account.id = member.account_id
    WHERE member.role = 'owner' AND account.status = 'active'
      AND member.account_id <> p_account;
    IF v_owners = 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'last_owner';
    END IF;
  END IF;
  IF p_role IS NULL THEN
    DELETE FROM operations_member WHERE account_id = p_account;
  ELSE
    INSERT INTO operations_member (account_id, role, added_by)
    VALUES (p_account, p_role, p_actor)
    ON CONFLICT (account_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now();
  END IF;
  v_result := jsonb_build_object(
    'accountId', p_account,
    'previousRole', v_previous,
    'role', p_role,
    'changed', v_previous IS DISTINCT FROM p_role
  );
  UPDATE operations_request SET result = v_result
  WHERE request_key = p_request AND action = 'member.set';
  RETURN v_result;
END $$;
