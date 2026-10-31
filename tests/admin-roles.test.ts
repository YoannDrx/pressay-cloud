import { describe, expect, it } from 'vitest';
import { operationsRoutes } from '../src/routes/operations.ts';
import { requiredRole, roleAllows } from '../src/lib/admin-roles.ts';

/**
 * Every administration route with the least role it needs. A new route fails
 * this test until its role is decided here.
 */
const expected: Record<string, 'owner' | 'support' | 'readonly'> = {
  'GET /admin/session': 'readonly',
  'GET /admin/overview': 'readonly',
  'GET /admin/metrics': 'readonly',
  'GET /admin/alerts': 'readonly',
  'GET /admin/health': 'readonly',
  'GET /admin/users': 'readonly',
  'GET /admin/users/:id': 'readonly',
  'GET /admin/campaigns': 'readonly',
  'GET /admin/campaigns/:id/usage': 'readonly',
  'GET /admin/referrals': 'readonly',
  'GET /admin/billing/events': 'readonly',
  'GET /admin/billing/financial-events': 'readonly',
  'GET /admin/audit-log': 'readonly',
  'GET /admin/waitlist': 'readonly',
  'GET /admin/waitlist/export': 'support',
  'GET /admin/members': 'owner',
  'POST /admin/members': 'owner',
  'POST /admin/members/:id/role': 'owner',
  'POST /admin/members/:id/remove': 'owner',
  'POST /admin/campaigns': 'support',
  'POST /admin/campaigns/:id/revoke': 'support',
  'POST /admin/grants/:id/revoke': 'support',
  'POST /admin/grants/:id/extend': 'support',
  'POST /admin/users/:id/grants': 'support',
  'POST /admin/users/:id/deletion': 'support',
  'POST /admin/devices/:id/revoke': 'support',
  'POST /admin/devices/:id/restore': 'support',
  'POST /admin/audit/external': 'support',
  'POST /admin/rewards/process': 'owner',
  'POST /admin/rewards/:id/retry': 'owner',
  'POST /admin/billing/events/:provider/:id/replay': 'owner',
  'PATCH /admin/gates/:channel/:id': 'owner',
  // Routes of the metrics and access-request changes, decided ahead of them.
  'GET /admin/metrics/advanced': 'readonly',
  'GET /admin/export/:file': 'readonly',
  'GET /admin/users/:id/export': 'support',
};
const sample = (path: string) =>
  `/v1${path.replaceAll(/:[a-z]+/g, '00000000-0000-4000-8000-000000000001')}`;

describe('administrator roles', () => {
  it('decides a role for every administration route', () => {
    const routes = operationsRoutes.routes
      .filter((route) => route.path.startsWith('/admin/') && route.method !== 'ALL')
      .map((route) => `${route.method} ${route.path}`);
    expect(routes.filter((route) => !(route in expected))).toEqual([]);
    for (const route of Object.keys(expected)) {
      const [method, path] = route.split(' ') as [string, string];
      expect(requiredRole(method, sample(path)), route).toBe(expected[route]);
    }
  });

  it('defaults unknown mutations to owner and unknown reads to every member', () => {
    expect(requiredRole('POST', '/v1/admin/something-new')).toBe('owner');
    expect(requiredRole('DELETE', '/v1/admin/users/x')).toBe('owner');
    expect(requiredRole('GET', '/v1/admin/something-new')).toBe('readonly');
    // Exports added by other changes are already classified.
    expect(requiredRole('GET', '/v1/admin/users/x/export')).toBe('support');
    expect(requiredRole('GET', '/v1/admin/export/churn.csv')).toBe('readonly');
  });

  it('orders roles owner > support > readonly', () => {
    expect(roleAllows('owner', 'support')).toBe(true);
    expect(roleAllows('support', 'support')).toBe(true);
    expect(roleAllows('support', 'owner')).toBe(false);
    expect(roleAllows('readonly', 'support')).toBe(false);
    expect(roleAllows('readonly', 'readonly')).toBe(true);
  });
});
