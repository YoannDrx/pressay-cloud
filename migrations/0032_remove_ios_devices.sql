-- Pressay for iPhone will not ship: Pressay is sold on macOS (site and Mac App
-- Store) and Windows only. Devices go back to the platforms and distribution
-- channels of 0021: 'macos' or 'windows', 'direct' or 'mas'.
-- No iPhone device was ever registered in production or staging. The check
-- below stops the migration, without touching any row, if one exists: such a
-- device must be removed deliberately (support action) before this runs.
-- Migration 0031 stays as deployed (checksums); this one supersedes it.
-- Every statement is idempotent so the file can be replayed safely.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pressay_device
    WHERE platform = 'ios' OR app_variant = 'app_store_ios'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'ios_devices_remain',
      HINT = 'Remove the iPhone devices from pressay_device before running 0032.';
  END IF;
END
$$;

ALTER TABLE pressay_device
  DROP CONSTRAINT IF EXISTS pressay_device_platform_check;

ALTER TABLE pressay_device
  ADD CONSTRAINT pressay_device_platform_check
  CHECK (platform IN ('macos', 'windows'));

ALTER TABLE pressay_device
  DROP CONSTRAINT IF EXISTS pressay_device_app_variant_check;

ALTER TABLE pressay_device
  ADD CONSTRAINT pressay_device_app_variant_check
  CHECK (app_variant IN ('direct', 'mas'));

COMMENT ON FUNCTION bootstrap_pressay_account(text, bytea, text, text, text, text) IS
  'Creates or loads a Cloud account and registers a macOS or Windows device within the shared three-device limit.';
