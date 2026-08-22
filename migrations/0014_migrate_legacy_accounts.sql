-- Preserve existing Pressay identities and effective access while the control plane
-- moves from the legacy plural tables to the local-first account model. Provider
-- customer and subscription identifiers are intentionally not copied: Stripe
-- identifiers are scoped to the account that created them, and Direct billing is
-- moving to a dedicated Pressay account.

DO $migration$
BEGIN
  -- Fresh Pressay Cloud databases never had the legacy plural tables. Keep the
  -- migration in the common chain so production-shaped cold starts and legacy
  -- upgrades can use the exact same immutable migration set.
  IF to_regclass('public.accounts') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO pressay_account (
    id,
    auth_user_id,
    status,
    created_at,
    updated_at
  )
  SELECT
    legacy_account.id,
    legacy_account.auth_subject,
    'active',
    legacy_account.created_at,
    greatest(legacy_account.updated_at, now())
  FROM accounts AS legacy_account
  WHERE legacy_account.deleted_at IS NULL
  ON CONFLICT DO NOTHING;

  -- Some early control-plane deployments had accounts but no entitlement
  -- table. Their identities are still migrated without manufacturing access.
  IF to_regclass('public.entitlements') IS NULL THEN
    RETURN;
  END IF;

  WITH legacy_access AS (
    SELECT
      legacy_account.id AS account_id,
      legacy_entitlement.plan_code,
      legacy_entitlement.status,
      COALESCE(
        legacy_entitlement.current_period_start,
        legacy_account.created_at
      ) AS valid_from,
      CASE
        WHEN legacy_entitlement.plan_code = 'lifetime_byok'
          AND legacy_entitlement.status IN ('active', 'trialing', 'past_due', 'canceled')
        THEN '9999-12-31 23:59:59+00'::timestamptz
        WHEN legacy_entitlement.status = 'trialing'
        THEN COALESCE(
          legacy_entitlement.trial_end,
          legacy_entitlement.current_period_end
        )
        ELSE legacy_entitlement.current_period_end
      END AS valid_until
    FROM accounts AS legacy_account
    LEFT JOIN entitlements AS legacy_entitlement
      ON legacy_entitlement.account_id = legacy_account.id
    WHERE legacy_account.deleted_at IS NULL
  ), effective_access AS (
    SELECT
      account_id,
      valid_from,
      valid_until,
      plan_code <> 'free'
        AND status IN ('active', 'trialing', 'past_due', 'canceled')
        AND valid_until > now() AS is_pro,
      status = 'trialing' AND valid_until > now() AS is_trial
    FROM legacy_access
  )
  INSERT INTO entitlement (
    account_id,
    tier,
    source,
    valid_from,
    valid_until,
    offline_grace_until
  )
  SELECT
    account_id,
    CASE WHEN is_pro THEN 'pro' ELSE 'free' END,
    CASE
      WHEN is_trial THEN 'trial'
      WHEN is_pro THEN 'support'
      ELSE 'none'
    END,
    valid_from,
    CASE WHEN is_pro THEN valid_until ELSE NULL END,
    CASE WHEN is_pro THEN valid_until + interval '72 hours' ELSE NULL END
  FROM effective_access
  ON CONFLICT (account_id) DO NOTHING;
END
$migration$;

COMMENT ON TABLE pressay_account IS
  'Cloud account keyed by the validated identity subject. Legacy provider billing identifiers are never copied across Stripe accounts.';
