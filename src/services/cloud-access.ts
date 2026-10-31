import { getEnvironment } from '../env.js';

/**
 * Apple Sandbox purchases are free. Production verifies them only so App
 * Review can buy Pro against the production API, so in production an
 * entitlement whose winning source is a Sandbox purchase (`entitlement.sandbox`)
 * never unlocks paid Cloud services: the Cloud processing quota and E2EE sync.
 * Paid subscriptions and support grants always take precedence over Sandbox
 * when the entitlement is recomputed, so they clear the flag.
 *
 * Staging and development only ever see Sandbox purchases, which must keep
 * exercising those services there.
 */
export function sandboxEntitlementUnlocksCloud(): boolean {
  return getEnvironment().PRESSAY_DEPLOYMENT_ENV !== 'production';
}

/**
 * SQL predicate to AND with `tier = 'pro'` checks on an `entitlement` alias.
 * Built only from the fixed alias and a constant, never from request input.
 */
export function paidCloudEntitlementPredicate(alias: 'e' | 'entitlement'): string {
  return sandboxEntitlementUnlocksCloud() ? 'true' : `${alias}.sandbox = false`;
}
