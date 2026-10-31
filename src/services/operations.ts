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
/**
 * Structured audit details: identifiers, durations, counts and error codes.
 * Never personal data (no email, name or customer-provided text).
 */
export type AuditDetails = Readonly<Record<string, string | number | boolean | null>>;
export interface AuditContext {
  /** Account the entry concerns, when there is one. */
  targetAccountId?: string | null;
  details?: AuditDetails;
}
/** Refuses values that could carry personal data into the ledger. */
export function assertSafeAuditDetails(details: AuditDetails): void {
  const entries = Object.entries(details);
  if (entries.length > 20) throw new Error('Too many audit details');
  for (const [key, value] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key))
      throw new Error(`Invalid audit detail key: ${key}`);
    if (typeof value === 'string' && (value.length > 120 || value.includes('@')))
      throw new Error(`Unsafe audit detail value: ${key}`);
  }
}
export async function audit(
  actor: string,
  action: string,
  target: string,
  reason: string,
  requestId: string,
  result = 'succeeded',
  context: AuditContext = {},
) {
  if (context.details) assertSafeAuditDetails(context.details);
  await getSql().query(
    'INSERT INTO operations_audit(actor_id,action,target_id,reason,request_id,result,target_account_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      actor,
      action,
      target,
      reason,
      requestId,
      result,
      context.targetAccountId ?? null,
      context.details ? JSON.stringify(context.details) : null,
    ],
  );
}
export type OperationsRole = 'owner' | 'support' | 'readonly';
export const operationsRoles: readonly OperationsRole[] = [
  'owner',
  'support',
  'readonly',
];
export interface OperationsMember {
  accountId: string;
  role: OperationsRole;
  /** True when this request claimed the owner seat (break-glass). */
  claimed: boolean;
}

/**
 * The administrator behind a verified session, or null. Members and their
 * role live in operations_member. A verified address listed in
 * PRESSAY_OPERATIONS_OWNER_EMAILS becomes owner only while no active owner
 * exists (first set-up, or recovery after the last owner's account was
 * deleted), and only from a session with an Authenticator app.
 */
export async function operationsMember(
  userId: string,
  email: string,
  verified: boolean,
  twoFactor: boolean,
): Promise<OperationsMember | null> {
  if (!verified) return null;
  const id = await accountId(userId);
  let claimed = false;
  if (
    twoFactor &&
    getEnvironment().PRESSAY_OPERATIONS_OWNER_EMAILS.includes(email.toLowerCase())
  ) {
    const rows = await getSql().query(
      `INSERT INTO operations_member (account_id, role)
      SELECT $1, 'owner'
      WHERE NOT EXISTS (
        SELECT 1 FROM operations_member member
        JOIN pressay_account account ON account.id = member.account_id
        WHERE member.role = 'owner' AND account.status = 'active'
      )
      ON CONFLICT (account_id) DO UPDATE SET role = 'owner', updated_at = now()
      RETURNING account_id`,
      [id],
    );
    claimed = rows.length > 0;
  }
  const rows = await getSql().query(
    'SELECT role FROM operations_member WHERE account_id=$1',
    [id],
  );
  const role = operationsRoles.find((candidate) => candidate === rows[0]?.role);
  return role ? { accountId: id, role, claimed } : null;
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
