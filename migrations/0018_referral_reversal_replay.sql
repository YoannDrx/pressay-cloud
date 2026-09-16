-- Repeated charge/refund/dispute notifications must preserve unresolved credits.
CREATE OR REPLACE FUNCTION reverse_pressay_referral(p_invoice text) RETURNS void LANGUAGE plpgsql AS $$
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
   UPDATE referral_reward SET status=CASE WHEN r.kind='credit' AND (r.status IN ('processing','applied','failed','review') OR r.first_attempt_at IS NOT NULL OR r.stripe_transaction_id IS NOT NULL OR r.applied_at IS NOT NULL) THEN 'review' ELSE 'cancelled' END,
     last_error_code='payment_reversed',locked_until=NULL WHERE id=r.id;
 END LOOP;
END $$;

-- Repair already-reversed credits whose manual-review state was lost on a replay.
UPDATE referral_reward r SET status='review',last_error_code='payment_reversed',locked_until=NULL
FROM referral_attribution a
WHERE a.id=r.attribution_id AND a.status='reversed' AND r.kind='credit' AND r.status='cancelled'
  AND (r.first_attempt_at IS NOT NULL OR r.stripe_transaction_id IS NOT NULL OR r.applied_at IS NOT NULL);
