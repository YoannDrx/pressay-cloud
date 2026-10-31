-- Serialize Stripe Checkout creation per account. The API reaches Neon over
-- stateless HTTP, so a transaction-scoped lock cannot be held across the
-- Stripe calls that check for an open session or a live subscription before
-- creating a new one. A short lease row can: the service takes it with a
-- conditional upsert, releases it when done, and an abandoned lease (crashed
-- or timed-out function) becomes free again once expires_at has passed.
-- The table holds no personal data and is removed with the account.
-- Every statement is idempotent so the file can be replayed safely.

CREATE TABLE IF NOT EXISTS billing_checkout_lease (
  account_id uuid PRIMARY KEY REFERENCES pressay_account (id) ON DELETE CASCADE,
  lease_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);

COMMENT ON TABLE billing_checkout_lease IS
  'At most one in-flight Stripe Checkout creation per account; rows are transient.';
