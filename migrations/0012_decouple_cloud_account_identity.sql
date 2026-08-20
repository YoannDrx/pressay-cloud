-- The Cloud API validates externally issued Better Auth JWTs. The subject is
-- therefore authoritative even when the issuer's user row lives in a separate
-- database. Keeping a local foreign key made every first desktop bootstrap fail.
ALTER TABLE pressay_account
  DROP CONSTRAINT IF EXISTS pressay_account_auth_user_id_fkey;

COMMENT ON COLUMN pressay_account.auth_user_id IS
  'Stable subject from the validated identity-provider JWT; no local user row required.';
