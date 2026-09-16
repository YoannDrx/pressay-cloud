-- Identity is hosted outside Cloud; retain only verified contact metadata.
CREATE TABLE account_contact (
 account_id uuid PRIMARY KEY REFERENCES pressay_account(id) ON DELETE CASCADE,
 email text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO account_contact(account_id,email)
SELECT a.id,u.email FROM pressay_account a JOIN "user" u ON u.id=a.auth_user_id WHERE u."emailVerified"=true;
-- Independent operations ledger. No audio, text, prompts or provider credentials.
CREATE TABLE operations_owner (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  account_id uuid UNIQUE REFERENCES pressay_account(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operations_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES pressay_account(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_id text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  request_id text NOT NULL,
  result text NOT NULL DEFAULT 'succeeded',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE access_campaign (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('access_grant','stripe_discount')),
  delivery text NOT NULL CHECK (delivery IN ('code','link')),
  secret_hash text UNIQUE,
  code_hint text,
  duration_days integer CHECK (duration_days BETWEEN 1 AND 365),
  restricted_email text,
  discount_percent integer CHECK (discount_percent BETWEEN 1 AND 100),
  discount_amount integer CHECK (discount_amount BETWEEN 1 AND 100000),
  max_redemptions integer NOT NULL CHECK (max_redemptions BETWEEN 1 AND 10000),
  redemptions integer NOT NULL DEFAULT 0 CHECK (redemptions >= 0 AND redemptions <= max_redemptions),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('provisioning','active','revoking','revoked','failed')),
  stripe_coupon_id text,
  stripe_promotion_id text,
  created_by uuid REFERENCES pressay_account(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'access_grant' AND duration_days IS NOT NULL AND secret_hash IS NOT NULL)
    OR (kind = 'stripe_discount' AND num_nonnulls(discount_percent,discount_amount) = 1))
);
CREATE TABLE access_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES pressay_account(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES access_campaign(id),
  source text NOT NULL CHECK (source IN ('invitation','referral','legacy')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,campaign_id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX access_grant_active ON access_grant(account_id,ends_at) WHERE revoked_at IS NULL;
-- Preserve pre-existing support/trial rights before making the ledger authoritative.
INSERT INTO access_grant(account_id,source,starts_at,ends_at)
SELECT account_id,'legacy',valid_from,valid_until FROM entitlement
WHERE source IN ('support','trial') AND valid_until > now();
CREATE TABLE referral_code (
  account_id uuid PRIMARY KEY REFERENCES pressay_account(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE
);
CREATE TABLE referral_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES pressay_account(id) ON DELETE CASCADE,
  referee_id uuid NOT NULL UNIQUE REFERENCES pressay_account(id) ON DELETE CASCADE,
  attributed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  status text NOT NULL DEFAULT 'attributed' CHECK(status IN ('attributed','converted','reversed','review')),
  invoice_id text UNIQUE,
  CHECK(referrer_id <> referee_id)
);
CREATE TABLE referral_payment (
  invoice_id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES pressay_account(id) ON DELETE CASCADE,
  paid_at timestamptz NOT NULL,
  amount_minor integer NOT NULL CHECK(amount_minor > 0),
  currency text NOT NULL,
  reversed_at timestamptz
);
CREATE TABLE referral_reward (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id uuid NOT NULL REFERENCES referral_attribution(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES pressay_account(id) ON DELETE CASCADE,
  side text NOT NULL CHECK(side IN ('referrer','referee')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','applied','failed','cancelled','review')),
  kind text CHECK(kind IN ('credit','grant','apple_ineligible')),
  amount_minor integer,
  currency text,
  customer_id text,
  grant_id uuid REFERENCES access_grant(id) ON DELETE SET NULL,
  stripe_transaction_id text,
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  locked_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE(attribution_id,side)
);
CREATE INDEX referral_reward_queue ON referral_reward(next_attempt_at) WHERE status IN ('pending','processing','failed');
CREATE TABLE launch_gate (
  channel text NOT NULL CHECK(channel IN ('direct','app_store')),
  id text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','passed','blocked')),
  evidence text NOT NULL DEFAULT '',
  checked_at timestamptz,
  PRIMARY KEY(channel,id)
);
INSERT INTO launch_gate(channel,id,label) VALUES
('direct','mediation','Contrat de médiation et conditions publiques'),
('direct','tax','Régime fiscal et configuration Stripe'),
('direct','billing','Recette Stripe : achat, renouvellement, impayé et remboursement'),
('direct','desktop','Binaire DMG, signature et mise à jour'),
('direct','capabilities','Capacités Pro, quotas et suppression de compte'),
('app_store','encryption','Conformité chiffrement Apple'),
('app_store','dsa','Adresse DSA et justificatif'),
('app_store','testflight','Recette TestFlight et achats StoreKit'),
('app_store','review','Validation App Review');

CREATE OR REPLACE FUNCTION recompute_pressay_entitlement(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_source text; v_from timestamptz; v_until timestamptz; v_sandbox boolean; v_count integer;
BEGIN
  PERFORM 1 FROM entitlement WHERE account_id=p_account_id FOR UPDATE;
  SELECT source,starts_at,ends_at,sandbox INTO v_source,v_from,v_until,v_sandbox FROM (
    SELECT provider AS source,COALESCE(current_period_starts_at,created_at) AS starts_at,
      current_period_ends_at AS ends_at,apple_environment='Sandbox' AS sandbox
    FROM billing_subscription WHERE account_id=p_account_id
      AND status IN ('trialing','active','past_due','grace') AND current_period_ends_at>now()
    UNION ALL
    SELECT 'support',starts_at,ends_at,false FROM access_grant
      WHERE account_id=p_account_id AND revoked_at IS NULL AND starts_at<=now() AND ends_at>now()
  ) candidates ORDER BY sandbox ASC,ends_at DESC,(source IN ('stripe','app_store')) DESC LIMIT 1;
  UPDATE entitlement SET tier=CASE WHEN v_source IS NULL THEN 'free' ELSE 'pro' END,
    source=COALESCE(v_source,'none'),valid_from=COALESCE(v_from,valid_from),valid_until=v_until,
    offline_grace_until=CASE WHEN v_until IS NULL THEN NULL WHEN v_sandbox THEN v_until ELSE v_until+interval '72 hours' END,
    revision=revision+1,updated_at=now()
  WHERE account_id=p_account_id AND (source IS DISTINCT FROM COALESCE(v_source,'none') OR valid_until IS DISTINCT FROM v_until);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count>0;
END $$;

CREATE FUNCTION claim_pressay_access(p_account uuid,p_email text,p_hash text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE c access_campaign%ROWTYPE; v_grant uuid; v_end timestamptz;
BEGIN
  -- All grant writers lock the entitlement first, including concurrent different codes.
  PERFORM 1 FROM entitlement WHERE account_id=p_account FOR UPDATE;
  SELECT * INTO c FROM access_campaign WHERE secret_hash=p_hash FOR UPDATE;
  IF c.id IS NULL OR c.kind<>'access_grant' OR c.status<>'active' OR c.expires_at<=now()
    OR c.redemptions>=c.max_redemptions OR (c.restricted_email IS NOT NULL AND lower(p_email)<>c.restricted_email)
    THEN RAISE EXCEPTION 'access_unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM access_grant WHERE account_id=p_account AND campaign_id=c.id)
    THEN RAISE EXCEPTION 'already_redeemed'; END IF;
  PERFORM recompute_pressay_entitlement(p_account);
  SELECT valid_until INTO v_end FROM entitlement WHERE account_id=p_account;
  IF v_end>=now()+make_interval(days=>c.duration_days)-interval '1 minute' THEN RAISE EXCEPTION 'access_not_improved'; END IF;
  INSERT INTO access_grant(account_id,campaign_id,source,ends_at)
    VALUES(p_account,c.id,'invitation',now()+make_interval(days=>c.duration_days)) RETURNING id INTO v_grant;
  UPDATE access_campaign SET redemptions=redemptions+1 WHERE id=c.id;
  PERFORM recompute_pressay_entitlement(p_account);
  RETURN v_grant;
END $$;

CREATE FUNCTION record_pressay_referral_payment(p_invoice text,p_account uuid,p_paid timestamptz,p_amount integer,p_currency text,p_monthly integer DEFAULT 799,p_annual integer DEFAULT 6900)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a referral_attribution%ROWTYPE;
BEGIN
  PERFORM 1 FROM pressay_account WHERE id=p_account FOR UPDATE;
  INSERT INTO referral_payment(invoice_id,account_id,paid_at,amount_minor,currency)
    VALUES(p_invoice,p_account,p_paid,p_amount,p_currency) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM referral_attribution WHERE referee_id=p_account FOR UPDATE;
  IF a.id IS NULL OR a.status<>'attributed' OR p_paid<a.attributed_at OR p_paid>a.expires_at
    OR EXISTS(SELECT 1 FROM referral_payment WHERE account_id=p_account AND invoice_id<>p_invoice AND paid_at<=p_paid)
    OR EXISTS(SELECT 1 FROM referral_reversal WHERE invoice_id=p_invoice)
    THEN RETURN; END IF;
  UPDATE referral_attribution SET status='converted',invoice_id=p_invoice WHERE id=a.id;
  -- Freeze the reward's nature and price at conversion, before asynchronous processing.
  INSERT INTO referral_reward(attribution_id,account_id,side,kind,amount_minor,currency,customer_id)
  SELECT a.id,beneficiary.id,beneficiary.side,
    CASE WHEN paid.provider='app_store' THEN 'apple_ineligible' WHEN paid.provider='stripe' THEN 'credit' ELSE 'grant' END,
    CASE WHEN paid.provider='stripe' THEN CASE WHEN paid.billing_interval='year' THEN round(p_annual::numeric*30/365)::int ELSE p_monthly END END,
    'eur',customer.stripe_customer_id
  FROM (VALUES (a.referrer_id,'referrer'),(a.referee_id,'referee')) AS beneficiary(id,side)
  LEFT JOIN LATERAL (SELECT provider,billing_interval FROM billing_subscription
    WHERE account_id=beneficiary.id AND apple_environment='Production' AND status IN ('active','trialing','past_due','grace') AND current_period_ends_at>now()
    ORDER BY (provider='app_store') DESC LIMIT 1) paid ON true
  LEFT JOIN billing_customer customer ON customer.account_id=beneficiary.id
  ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION apply_pressay_referral_grant(p_reward uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE r referral_reward%ROWTYPE; v_grant uuid; v_start timestamptz;
BEGIN
  SELECT * INTO r FROM referral_reward WHERE id=p_reward FOR UPDATE;
  IF r.status<>'processing' OR r.kind<>'grant' THEN RETURN NULL; END IF;
  IF r.grant_id IS NOT NULL THEN RETURN r.grant_id; END IF;
  PERFORM 1 FROM entitlement WHERE account_id=r.account_id FOR UPDATE;
  SELECT greatest(now(),COALESCE(max(ends_at),now())) INTO v_start FROM access_grant
    WHERE account_id=r.account_id AND revoked_at IS NULL;
  INSERT INTO access_grant(account_id,source,starts_at,ends_at)
    VALUES(r.account_id,'referral',now(),v_start+interval '30 days') RETURNING id INTO v_grant;
  UPDATE referral_reward SET grant_id=v_grant,status='applied',applied_at=now(),locked_until=NULL WHERE id=r.id;
  PERFORM recompute_pressay_entitlement(r.account_id);
  RETURN v_grant;
END $$;
CREATE TABLE referral_reversal(invoice_id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION reverse_pressay_referral(p_invoice text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r referral_reward%ROWTYPE;
BEGIN
 INSERT INTO referral_reversal(invoice_id) VALUES(p_invoice) ON CONFLICT DO NOTHING;
 UPDATE referral_payment SET reversed_at=now() WHERE invoice_id=p_invoice;
 UPDATE referral_attribution SET status='reversed' WHERE invoice_id=p_invoice;
 FOR r IN SELECT reward.* FROM referral_reward reward JOIN referral_attribution a ON a.id=reward.attribution_id
   WHERE a.invoice_id=p_invoice FOR UPDATE OF reward LOOP
   IF r.kind='grant' AND r.grant_id IS NOT NULL THEN
     PERFORM 1 FROM entitlement WHERE account_id=r.account_id FOR UPDATE;
     UPDATE access_grant SET revoked_at=now() WHERE id=r.grant_id;
     PERFORM recompute_pressay_entitlement(r.account_id);
   END IF;
   UPDATE referral_reward SET status=CASE WHEN r.kind='credit' AND (r.status IN ('processing','applied','failed')) THEN 'review' ELSE 'cancelled' END,
     last_error_code='payment_reversed',locked_until=NULL WHERE id=r.id;
 END LOOP;
END $$;
CREATE FUNCTION revoke_pressay_grant(p_id uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_account uuid;
BEGIN
 SELECT account_id INTO v_account FROM access_grant WHERE id=p_id;
 IF v_account IS NULL THEN RETURN false; END IF;
 PERFORM 1 FROM entitlement WHERE account_id=v_account FOR UPDATE;
 UPDATE access_grant SET revoked_at=COALESCE(revoked_at,now()) WHERE id=p_id;
 PERFORM recompute_pressay_entitlement(v_account);
 RETURN true;
END $$;

CREATE FUNCTION attribute_pressay_referral(p_account uuid,p_code text,p_issued timestamptz)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
 PERFORM 1 FROM pressay_account WHERE id=p_account FOR UPDATE;
 IF p_issued < now()-interval '30 days' OR p_issued > now()+interval '60 seconds' THEN RETURN false; END IF;
 INSERT INTO referral_attribution(referrer_id,referee_id,expires_at)
 SELECT c.account_id,p_account,p_issued+interval '30 days' FROM referral_code c
 JOIN pressay_account a ON a.id=c.account_id AND a.status='active'
 WHERE c.code=p_code AND c.account_id<>p_account
 AND NOT EXISTS(SELECT 1 FROM billing_subscription WHERE account_id=p_account AND apple_environment='Production')
 AND NOT EXISTS(SELECT 1 FROM referral_payment WHERE account_id=p_account)
 ON CONFLICT(referee_id) DO NOTHING RETURNING id INTO v_id;
 RETURN v_id IS NOT NULL;
END $$;

-- Complete Cloud erasure even when the identity belongs to the separate web database.
-- Retain the opaque subject tombstone to prevent a still-valid JWT recreating this account.
CREATE FUNCTION complete_pressay_account_deletion(p_account uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_subject text;
BEGIN
 SELECT a.auth_user_id INTO v_subject FROM pressay_account a JOIN account_deletion_job j ON j.account_id=a.id
 WHERE a.id=p_account AND a.status='deleting' AND j.state='processing' FOR UPDATE OF a;
 IF v_subject IS NULL THEN RETURN false; END IF;
 DELETE FROM referral_attribution WHERE referrer_id=p_account OR referee_id=p_account;
 DELETE FROM referral_payment WHERE account_id=p_account;
 DELETE FROM referral_code WHERE account_id=p_account;
 DELETE FROM access_grant WHERE account_id=p_account;
 DELETE FROM account_contact WHERE account_id=p_account;
 DELETE FROM sync_change WHERE account_id=p_account;
 DELETE FROM account_recovery_code WHERE account_id=p_account;
 DELETE FROM usage_reservation WHERE account_id=p_account;
 DELETE FROM usage_period WHERE account_id=p_account;
 DELETE FROM idempotency_record WHERE account_id=p_account;
 DELETE FROM pressay_device WHERE account_id=p_account;
 DELETE FROM billing_subscription WHERE account_id=p_account;
 DELETE FROM billing_customer WHERE account_id=p_account;
 UPDATE entitlement SET tier='free',source='none',valid_until=NULL,offline_grace_until=NULL,revision=revision+1 WHERE account_id=p_account;
 DELETE FROM "user" WHERE id=v_subject;
 UPDATE pressay_account SET status='deleted',updated_at=now() WHERE id=p_account;
 UPDATE account_deletion_job SET state='completed',completed_at=now(),last_error_code=NULL WHERE account_id=p_account;
 RETURN true;
END $$;
