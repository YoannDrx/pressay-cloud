ALTER TABLE sync_change
  DROP CONSTRAINT sync_change_account_id_object_type_client_object_id_revisio_key;

ALTER TABLE sync_change
  ADD CONSTRAINT sync_change_device_revision_key
  UNIQUE (account_id, object_type, client_object_id, revision, source_device_id);

CREATE INDEX sync_change_conflict_idx
  ON sync_change (account_id, object_type, client_object_id, revision);

ALTER TABLE pressay_device
  DROP CONSTRAINT pressay_device_check;

ALTER TABLE pressay_device
  ADD CONSTRAINT pressay_device_sync_state_check CHECK (
    (public_key IS NULL AND encrypted_account_key IS NULL AND approved_at IS NULL)
    OR (public_key IS NOT NULL AND encrypted_account_key IS NULL AND approved_at IS NULL)
    OR (public_key IS NOT NULL AND encrypted_account_key IS NOT NULL AND approved_at IS NOT NULL)
  );
