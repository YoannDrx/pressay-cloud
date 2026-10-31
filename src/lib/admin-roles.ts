import type { OperationsRole } from '../contracts/operations-wire.js';

const rank: Record<OperationsRole, number> = { readonly: 0, support: 1, owner: 2 };

/** True when `role` includes everything `required` may do. */
export function roleAllows(role: OperationsRole, required: OperationsRole): boolean {
  return rank[role] >= rank[required];
}

const SEGMENT = '[^/]+';
/** Reads that hand personal data out of the administration, or list admins. */
const restrictedReads: [RegExp, OperationsRole][] = [
  [/\/admin\/members\/?$/, 'owner'],
  [new RegExp(`/admin/users/${SEGMENT}/export/?$`), 'support'],
  [/\/admin\/waitlist\/export\/?$/, 'support'],
];
/**
 * Support actions: customer help without billing or roles. Campaign routes
 * are also checked in their handlers (Stripe promotions stay owner-only).
 */
const supportMutations: RegExp[] = [
  new RegExp(`/admin/users/${SEGMENT}/(grants|deletion)/?$`),
  new RegExp(`/admin/grants/${SEGMENT}/(extend|revoke)/?$`),
  new RegExp(`/admin/devices/${SEGMENT}/(revoke|restore)/?$`),
  /\/admin\/audit\/external\/?$/,
  /\/admin\/campaigns\/?$/,
  new RegExp(`/admin/campaigns/${SEGMENT}/revoke/?$`),
];

/**
 * Least role for an admin request. Reads are open to every member unless
 * listed; a mutation is owner-only unless it is a listed support action, so a
 * new route defaults to the strictest role.
 */
export function requiredRole(method: string, path: string): OperationsRole {
  if (method === 'GET' || method === 'HEAD')
    return restrictedReads.find(([pattern]) => pattern.test(path))?.[1] ?? 'readonly';
  return supportMutations.some((pattern) => pattern.test(path)) ? 'support' : 'owner';
}
