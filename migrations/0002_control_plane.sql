CREATE TABLE pressay_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id text NOT NULL UNIQUE REFERENCES "user" (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting', 'deleted')),
  deletion_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active' AND deletion_requested_at IS NULL) OR status <> 'active')
);

CREATE TABLE pressay_device (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES pressay_account (id) ON DELETE CASCADE,
  device_identifier_hash bytea NOT NULL CHECK (octet_length(device_identifier_hash) = 32),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  platform text NOT NULL DEFAULT 'macos' CHECK (platform = 'macos'),
  app_variant text NOT NULL CHECK (app_variant IN ('direct', 'mas')),
  app_version text NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 64),
  public_key bytea CHECK (public_key IS NULL OR octet_length(public_key) BETWEEN 32 AND 512),
  encrypted_account_key bytea CHECK (
    encrypted_account_key IS NULL OR octet_length(encrypted_account_key) BETWEEN 48 AND 16384
  ),
  approved_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, device_identifier_hash),
  CHECK (
    (public_key IS NULL AND encrypted_account_key IS NULL AND approved_at IS NULL)
    OR (public_key IS NOT NULL AND encrypted_account_key IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX pressay_device_active_idx
  ON pressay_device (account_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE billing_customer (
  account_id uuid PRIMARY KEY REFERENCES pressay_account (id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  app_store_original_transaction_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (stripe_customer_id IS NOT NULL OR app_store_original_transaction_id IS NOT NULL)
);

CREATE TABLE billing_product (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('stripe', 'app_store')),
  provider_product_id text NOT NULL,
  provider_price_id text NOT NULL,
  tier text NOT NULL CHECK (tier = 'pro'),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_price_id)
);

CREATE UNIQUE INDEX billing_product_one_active_idx
  ON billing_product (provider, billing_interval)
  WHERE active;

CREATE TABLE billing_subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES pressay_account (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe', 'app_store')),
  provider_subscription_id text NOT NULL,
  provider_product_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('trialing', 'active', 'past_due', 'grace', 'paused', 'canceled', 'expired', 'refunded')
  ),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  trial_ends_at timestamptz,
  current_period_starts_at timestamptz,
  current_period_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  provider_event_occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id)
);

CREATE INDEX billing_subscription_account_idx
  ON billing_subscription (account_id, provider_event_occurred_at DESC);

CREATE TABLE entitlement (
  account_id uuid PRIMARY KEY REFERENCES pressay_account (id) ON DELETE CASCADE,
  tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
  source text NOT NULL DEFAULT 'none' CHECK (source IN ('none', 'stripe', 'app_store', 'support')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  offline_grace_until timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (tier = 'free' OR (source <> 'none' AND valid_until IS NOT NULL)),
  CHECK (offline_grace_until IS NULL OR valid_until IS NOT NULL)
);

CREATE TABLE plan_limit (
  tier text PRIMARY KEY CHECK (tier IN ('free', 'pro')),
  cloud_transcription_seconds integer NOT NULL CHECK (cloud_transcription_seconds >= 0),
  cloud_transformations integer NOT NULL CHECK (cloud_transformations >= 0),
  cloud_devices integer NOT NULL CHECK (cloud_devices >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plan_limit (
  tier,
  cloud_transcription_seconds,
  cloud_transformations,
  cloud_devices
) VALUES
  ('free', 0, 0, 0),
  ('pro', 36000, 2000, 3);

CREATE TABLE usage_period (
  account_id uuid NOT NULL REFERENCES pressay_account (id) ON DELETE CASCADE,
  period_start date NOT NULL,
  transcription_seconds_used integer NOT NULL DEFAULT 0 CHECK (transcription_seconds_used >= 0),
  transcription_seconds_reserved integer NOT NULL DEFAULT 0 CHECK (transcription_seconds_reserved >= 0),
  transformations_used integer NOT NULL DEFAULT 0 CHECK (transformations_used >= 0),
  transformations_reserved integer NOT NULL DEFAULT 0 CHECK (transformations_reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, period_start),
  CHECK (period_start = date_trunc('month', period_start)::date)
);

CREATE TABLE usage_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES pressay_account (id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES pressay_device (id) ON DELETE CASCADE,
  period_start date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cloud_transcription', 'cloud_transformation')),
  units integer NOT NULL CHECK (units > 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'finalized', 'released', 'expired')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 255),
  provider_operation_id text,
  expires_at timestamptz NOT NULL,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (account_id, period_start) REFERENCES usage_period (account_id, period_start),
  CHECK ((status = 'finalized') = (finalized_at IS NOT NULL))
);

CREATE INDEX usage_reservation_expiry_idx
  ON usage_reservation (expires_at)
  WHERE status = 'reserved';

CREATE TABLE idempotency_record (
  account_id uuid NOT NULL REFERENCES pressay_account (id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('billing', 'transcription', 'transformation', 'sync')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 255),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'completed', 'failed')),
  response_status smallint CHECK (response_status BETWEEN 200 AND 599),
  response_code text,
  resource_id uuid,
  locked_until timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, scope, idempotency_key),
  CHECK ((state = 'completed') = (response_status IS NOT NULL))
);

CREATE INDEX idempotency_record_expiry_idx ON idempotency_record (expires_at);

CREATE TABLE provider_event (
  provider text NOT NULL CHECK (provider IN ('stripe', 'apple')),
  provider_event_id text NOT NULL,
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 160),
  provider_occurred_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'received' CHECK (state IN ('received', 'applied', 'ignored', 'failed')),
  error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider, provider_event_id),
  CHECK ((state IN ('applied', 'ignored', 'failed')) = (processed_at IS NOT NULL))
);

CREATE INDEX provider_event_processing_idx
  ON provider_event (received_at)
  WHERE state IN ('received', 'failed');

CREATE TABLE sync_change (
  sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES pressay_account (id) ON DELETE CASCADE,
  source_device_id uuid NOT NULL REFERENCES pressay_device (id) ON DELETE CASCADE,
  object_type text NOT NULL CHECK (object_type IN ('mode', 'profile', 'dictionary', 'preference')),
  client_object_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  encrypted_envelope bytea NOT NULL CHECK (
    octet_length(encrypted_envelope) BETWEEN 48 AND 1048576
  ),
  envelope_version smallint NOT NULL DEFAULT 1 CHECK (envelope_version > 0),
  tombstone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, object_type, client_object_id, revision)
);

CREATE INDEX sync_change_cursor_idx ON sync_change (account_id, sequence_id);

CREATE TABLE account_recovery_code (
  account_id uuid PRIMARY KEY REFERENCES pressay_account (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  encrypted_account_key bytea NOT NULL CHECK (
    octet_length(encrypted_account_key) BETWEEN 48 AND 16384
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

CREATE TABLE account_deletion_job (
  account_id uuid PRIMARY KEY REFERENCES pressay_account (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'processing', 'completed', 'failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);

COMMENT ON TABLE sync_change IS
  'Opaque E2EE settings envelopes only. Transcripts, selected text, prompts, audio and BYOK keys are forbidden.';
COMMENT ON TABLE provider_event IS
  'Provider webhook metadata only. Raw webhook bodies are verified in memory and never persisted.';
