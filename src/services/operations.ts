import { createHash, createHmac, randomUUID } from 'node:crypto';
import { getSql } from '../db/client.js';
import { getEnvironment, requireEnvironmentValue } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { getStripe } from '../billing/stripe-client.js';
import type { CampaignInput } from '../contracts/operations.js';

export async function accountId(userId: string): Promise<string> {
  const rows = await getSql().query(
    "SELECT id FROM pressay_account WHERE auth_user_id=$1 AND status='active'",
    [userId],
  );
  if (!rows[0]) throw new ApiError(403, 'account_not_active', 'Account unavailable');
  return String(rows[0].id);
}
export async function audit(
  actor: string,
  action: string,
  target: string,
  reason: string,
  requestId: string,
  result = 'succeeded',
) {
  await getSql().query(
    'INSERT INTO operations_audit(actor_id,action,target_id,reason,request_id,result) VALUES($1,$2,$3,$4,$5,$6)',
    [actor, action, target, reason, requestId, result],
  );
}
export async function ownerAccount(userId: string, email: string, verified: boolean) {
  const id = await accountId(userId);
  if (verified && email.toLowerCase() === 'yoann.andrieux@gmail.com') {
    await getSql().query(
      `INSERT INTO operations_owner(singleton,account_id) VALUES(true,$1) ON CONFLICT DO NOTHING`,
      [id],
    );
  }
  const rows = await getSql().query(
    'SELECT account_id FROM operations_owner WHERE account_id=$1',
    [id],
  );
  return verified && rows.length ? id : null;
}
export function secretHash(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}
export async function createCampaign(
  actor: string,
  input: CampaignInput,
  requestId: string,
) {
  const id = randomUUID();
  const secret = createHmac(
    'sha256',
    requireEnvironmentValue(
      getEnvironment().PRESSAY_CAMPAIGN_SECRET,
      'PRESSAY_CAMPAIGN_SECRET',
    ),
  )
    .update(input.idempotencyKey)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
  const expiresAt =
    input.expiresAt ?? new Date(Date.now() + 30 * 86400000).toISOString();
  if (new Date(expiresAt).getTime() <= Date.now())
    throw new ApiError(422, 'expiration_in_past', 'Choose a future expiration');
  await audit(
    actor,
    'campaign.create.requested',
    input.idempotencyKey,
    input.reason,
    requestId,
    'requested',
  );
  const rows = await getSql().query(
    `INSERT INTO access_campaign(id,request_key,kind,delivery,secret_hash,code_hint,duration_days,restricted_email,discount_percent,discount_amount,max_redemptions,expires_at,status,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'provisioning',$13)
    ON CONFLICT(request_key) DO NOTHING RETURNING id`,
    [
      id,
      input.idempotencyKey,
      input.kind,
      input.delivery,
      secretHash(secret),
      secret.slice(-4),
      input.kind === 'access_grant' ? input.durationDays : null,
      input.restrictedEmail ?? null,
      input.discountPercent ?? null,
      input.discountAmount ?? null,
      input.maxRedemptions,
      expiresAt,
      actor,
    ],
  );
  if (!rows.length)
    throw new ApiError(
      409,
      'campaign_already_created',
      'Inspect or revoke the existing campaign; its secret is shown only once',
    );
  try {
    if (input.kind === 'stripe_discount') {
      const stripe = getStripe();
      const product = requireEnvironmentValue(
        getEnvironment().STRIPE_PRODUCT_PRO,
        'STRIPE_PRODUCT_PRO',
      );
      const coupon = await stripe.coupons.create(
        {
          duration: 'once',
          applies_to: { products: [product] },
          ...(input.discountPercent
            ? { percent_off: input.discountPercent }
            : { amount_off: Number(input.discountAmount), currency: 'eur' }),
          max_redemptions: input.maxRedemptions,
          redeem_by: Math.floor(new Date(expiresAt).getTime() / 1000),
          metadata: { pressay_campaign_id: id },
        },
        { idempotencyKey: `campaign/coupon/${id}` },
      );
      await getSql().query(
        'UPDATE access_campaign SET stripe_coupon_id=$2 WHERE id=$1',
        [id, coupon.id],
      );
      const promotion = await stripe.promotionCodes.create(
        {
          promotion: { type: 'coupon', coupon: coupon.id },
          code: secret,
          max_redemptions: input.maxRedemptions,
          expires_at: Math.floor(new Date(expiresAt).getTime() / 1000),
        },
        { idempotencyKey: `campaign/promotion/${id}` },
      );
      await getSql().query(
        "UPDATE access_campaign SET stripe_coupon_id=$2,stripe_promotion_id=$3,status='active' WHERE id=$1",
        [id, coupon.id, promotion.id],
      );
    } else
      await getSql().query("UPDATE access_campaign SET status='active' WHERE id=$1", [
        id,
      ]);
    await audit(actor, 'campaign.created', id, input.reason, requestId);
    return {
      id,
      secret,
      link:
        input.delivery === 'link'
          ? `https://press-say.app/access/${secret}`
          : undefined,
    };
  } catch {
    await getSql().query(
      "UPDATE access_campaign SET status='failed' WHERE id=$1 AND status='provisioning'",
      [id],
    );
    await audit(actor, 'campaign.create.failed', id, input.reason, requestId, 'failed');
    throw new ApiError(
      503,
      'campaign_creation_failed',
      'Campaign creation needs review',
    );
  }
}
export async function revokeCampaign(
  id: string,
  actor: string,
  reason: string,
  requestId: string,
) {
  await audit(actor, 'campaign.revoke.requested', id, reason, requestId, 'requested');
  const rows = await getSql().query(
    "UPDATE access_campaign SET status='revoking' WHERE id=$1 RETURNING stripe_promotion_id,stripe_coupon_id",
    [id],
  );
  if (!rows[0]) throw new ApiError(404, 'campaign_not_found', 'Campaign not found');
  if (rows[0].stripe_promotion_id)
    await getStripe().promotionCodes.update(String(rows[0].stripe_promotion_id), {
      active: false,
    });
  if (rows[0].stripe_coupon_id) {
    try {
      await getStripe().coupons.del(String(rows[0].stripe_coupon_id));
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'resource_missing'
      ))
        throw error;
    }
  }
  await getSql().query("UPDATE access_campaign SET status='revoked' WHERE id=$1", [id]);
  await audit(actor, 'campaign.revoked', id, reason, requestId);
}
export async function claimAccess(id: string, email: string, secret: string) {
  try {
    const rows = await getSql().query('SELECT claim_pressay_access($1,$2,$3) AS id', [
      id,
      email,
      secretHash(secret),
    ]);
    return { grantId: String(rows[0]?.id) };
  } catch (error) {
    for (const code of [
      'access_unavailable',
      'already_redeemed',
      'access_not_improved',
    ])
      if (error instanceof Error && error.message.includes(code))
        throw new ApiError(409, code, 'This code cannot improve your access');
    throw error;
  }
}
