CREATE TABLE billing_financial_event (
  provider text NOT NULL CHECK (provider = 'stripe'),
  provider_event_id text NOT NULL,
  provider_object_id text NOT NULL,
  account_id uuid REFERENCES pressay_account (id) ON DELETE SET NULL,
  provider_subscription_id text,
  kind text NOT NULL CHECK (
    kind IN ('invoice_paid', 'invoice_failed', 'invoice_voided', 'refund', 'dispute')
  ),
  status text NOT NULL CHECK (char_length(status) BETWEEN 1 AND 80),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  full_reversal boolean NOT NULL DEFAULT false,
  provider_occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id),
  FOREIGN KEY (provider, provider_event_id)
    REFERENCES provider_event (provider, provider_event_id) ON DELETE CASCADE
);

CREATE INDEX billing_financial_event_account_idx
  ON billing_financial_event (account_id, provider_occurred_at DESC);

COMMENT ON TABLE billing_financial_event IS
  'Provider identifiers and monetary lifecycle metadata only. Raw payloads and payment instruments are forbidden.';
