CREATE TABLE billing_legal_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES pressay_account(id) ON DELETE CASCADE,
  checkout_idempotency_key text NOT NULL CHECK (
    length(checkout_idempotency_key) BETWEEN 16 AND 255
  ),
  terms_version text NOT NULL CHECK (
    terms_version ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
  ),
  immediate_performance_consent boolean NOT NULL CHECK (
    immediate_performance_consent = true
  ),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, checkout_idempotency_key)
);

CREATE INDEX billing_legal_acceptance_account_idx
  ON billing_legal_acceptance (account_id, accepted_at DESC);
