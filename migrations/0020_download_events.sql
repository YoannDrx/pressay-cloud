-- Public download counter (anonymous):
-- * one row per real download started from press-say.app, keyed by a random
--   identifier the web server draws per request, so a retry is counted once;
-- * no IP address, user agent, account or cookie is stored, so a row cannot be
--   linked to a person.

CREATE TABLE IF NOT EXISTS download_event (
  id uuid PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('macos', 'windows')),
  asset_type text NOT NULL CHECK (asset_type IN ('dmg', 'exe', 'msi')),
  app_version text NOT NULL CHECK (length(app_version) BETWEEN 1 AND 64),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  campaign text CHECK (length(campaign) BETWEEN 1 AND 64),
  referral_code text CHECK (length(referral_code) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS download_event_created_at_idx
  ON download_event (created_at DESC);

COMMENT ON TABLE download_event IS
  'Anonymous download starts from the public site. Personal data is forbidden.';
