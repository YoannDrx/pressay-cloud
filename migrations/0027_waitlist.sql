-- Platform waitlists (iPhone, Windows): people who asked to be told when
-- Pressay ships on a platform. Only what is needed to write to them once:
-- the address, the platform, the language of the message, where the form was
-- shown and when consent was given. No IP address, no user agent, no account.
-- A second sign-up for the same address and platform keeps one row.
-- Retention (docs/ARCHITECTURE.md): the daily retention job deletes an entry
-- PRESSAY_RETENTION_WAITLIST_DAYS (default 730) after its consent, and 30
-- days after an unsubscription.
-- Additive; every statement is idempotent so the file can be replayed safely.

CREATE TABLE IF NOT EXISTS waitlist_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (
    char_length(email) BETWEEN 3 AND 254 AND email = lower(email) AND email LIKE '%@%'
  ),
  platform text NOT NULL CHECK (platform IN ('ios', 'windows')),
  locale text NOT NULL CHECK (locale IN ('fr', 'en')),
  source text NOT NULL CHECK (source ~ '^[a-z0-9_-]{1,40}$'),
  consent_at timestamptz NOT NULL,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, platform)
);

CREATE INDEX IF NOT EXISTS waitlist_entry_platform_idx
  ON waitlist_entry (platform, created_at DESC);

CREATE INDEX IF NOT EXISTS waitlist_entry_retention_idx
  ON waitlist_entry (consent_at);

COMMENT ON TABLE waitlist_entry IS
  'Opt-in platform waitlists; email only, no IP address or user agent.';
