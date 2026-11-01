-- Pressay for iPhone. An iPhone is a device like any other: it records its
-- platform and distribution channel and shares the account's three Cloud slots
-- with Macs and PCs (the bootstrap and restore functions count every active
-- device whatever its platform, so neither needs a new body).
-- Nothing else changes for existing rows: code that predates this migration
-- keeps writing and reading 'macos', 'windows', 'direct' and 'mas'.
-- Every statement is idempotent so the file can be replayed safely.

ALTER TABLE pressay_device
  DROP CONSTRAINT IF EXISTS pressay_device_platform_check;

ALTER TABLE pressay_device
  ADD CONSTRAINT pressay_device_platform_check
  CHECK (platform IN ('macos', 'windows', 'ios'));

ALTER TABLE pressay_device
  DROP CONSTRAINT IF EXISTS pressay_device_app_variant_check;

ALTER TABLE pressay_device
  ADD CONSTRAINT pressay_device_app_variant_check
  CHECK (app_variant IN ('direct', 'mas', 'app_store_ios'));

COMMENT ON FUNCTION bootstrap_pressay_account(text, bytea, text, text, text, text) IS
  'Creates or loads a Cloud account and registers a macOS, Windows or iOS device within the shared three-device limit.';
