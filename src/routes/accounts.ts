import { zValidator } from '@hono/zod-validator';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import {
  bootstrapAccountRequestSchema,
  bootstrapAccountResponseSchema,
  bootstrapWebAccountResponseSchema,
  deviceListResponseSchema,
  entitlementResponseSchema,
} from '../contracts/account.js';
import { requireAuthentication } from '../lib/auth-middleware.js';
import { ApiError } from '../lib/errors.js';
import { rateLimit } from '../lib/rate-limit.js';
import {
  isRecentAuthentication,
  RECENT_AUTHENTICATION_MAX_AGE_SECONDS,
} from '../lib/recent-authentication.js';
import {
  assertActiveDevice,
  bootstrapAccount,
  recordAccountContact,
  bootstrapWebAccount,
  getMe,
  getUsage,
  listDevices,
  requestAccountDeletion,
  revokeDevice,
} from '../services/accounts.js';
import {
  getEntitlementPublicJwk,
  signEntitlementSnapshot,
} from '../services/entitlements.js';
import { exportAccountData } from '../services/data-export.js';
import type { AppEnvironment } from '../types.js';

export const accountRoutes = new Hono<AppEnvironment>();

accountRoutes.use('/accounts/*', requireAuthentication);
accountRoutes.use('/me', requireAuthentication);
accountRoutes.use('/me/*', requireAuthentication);
accountRoutes.use('/devices', requireAuthentication);
accountRoutes.use('/devices/*', requireAuthentication);
accountRoutes.use('/entitlements', requireAuthentication);
accountRoutes.use('/usage', requireAuthentication);

accountRoutes.post(
  '/accounts/bootstrap',
  zValidator('json', bootstrapAccountRequestSchema, (result) => {
    if (!result.success) {
      throw new ApiError(422, 'invalid_request', 'Invalid bootstrap request');
    }
  }),
  async (context) => {
    const result = await bootstrapAccount(
      context.get('authUserId'),
      context.req.valid('json'),
    );
    if (context.get('authEmailVerified'))
      await recordAccountContact(context.get('authUserId'), context.get('authEmail'));
    return context.json(
      bootstrapAccountResponseSchema.parse({
        accountId: result.accountId,
        created: result.created,
        device: { id: result.deviceId },
        entitlement: result.entitlement,
      }),
      result.created ? 201 : 200,
    );
  },
);

accountRoutes.post('/accounts/web-bootstrap', async (context) => {
  const result = await bootstrapWebAccount(context.get('authUserId'));
  if (context.get('authEmailVerified'))
    await recordAccountContact(context.get('authUserId'), context.get('authEmail'));
  return context.json(bootstrapWebAccountResponseSchema.parse(result));
});

accountRoutes.get('/me', async (context) => {
  return context.json(await getMe(context.get('authUserId'), context.get('authEmail')));
});

accountRoutes.delete('/me', rateLimit('account_deletion', 5), async (context) => {
  requireRecentWebAuthentication(context);
  await requestAccountDeletion(context.get('authUserId'), {
    acknowledgeAppleSubscription:
      context.req.query('acknowledgeAppleSubscription') === 'true',
  });
  return context.body(null, 202);
});

accountRoutes.get('/me/export', rateLimit('account_export', 5), async (context) => {
  const data = await exportAccountData(context.get('authUserId'));
  context.header('Cache-Control', 'private, no-store');
  context.header(
    'Content-Disposition',
    'attachment; filename="pressay-cloud-export.json"',
  );
  return context.json(data);
});

accountRoutes.get('/devices', async (context) => {
  return context.json(
    deviceListResponseSchema.parse({
      devices: await listDevices(context.get('authUserId')),
      limit: 3,
    }),
  );
});

accountRoutes.delete('/devices/:id', async (context) => {
  const deviceId = zUuid(context.req.param('id'));
  await revokeDevice(context.get('authUserId'), deviceId);
  return context.body(null, 204);
});

accountRoutes.get('/entitlements', async (context) => {
  const deviceId = zUuid(context.req.header('x-device-id') ?? '');
  const me = await getMe(context.get('authUserId'), context.get('authEmail'));
  await assertActiveDevice(context.get('authUserId'), deviceId);
  const usage = await getUsage(context.get('authUserId'));
  return context.json(
    entitlementResponseSchema.parse({
      entitlement: me.entitlement,
      usage,
      signedSnapshot: await signEntitlementSnapshot({
        accountId: me.accountId,
        deviceId,
        entitlement: me.entitlement,
        usage,
      }),
    }),
  );
});

accountRoutes.get('/entitlements/jwks', (context) => {
  return context.json({ keys: [getEntitlementPublicJwk()] });
});

accountRoutes.get('/usage', async (context) => {
  return context.json(await getUsage(context.get('authUserId')));
});

/**
 * A web session can delete its account only with proof, bound to that
 * session, of a sign-in or second factor less than ten minutes old. The web
 * server adds it to its proxy token after Better Auth has checked the session
 * freshness; a long-lived session alone is not enough.
 *
 * Desktop OAuth access tokens (never `webProxy`) keep their current contract:
 * they are short-lived and refreshed by the signed-in app itself.
 */
function requireRecentWebAuthentication(context: Context<AppEnvironment>): void {
  if (!context.get('authWebProxy')) return;
  const sessionBound = context.get('authSessionId') !== '';
  if (
    sessionBound &&
    (isRecentAuthentication(context.get('authSignedInAt')) ||
      isRecentAuthentication(context.get('authStepUpAt')))
  )
    return;
  throw new ApiError(
    403,
    'recent_authentication_required',
    'Sign in again to delete this account',
    {},
    { maxAgeSeconds: String(RECENT_AUTHENTICATION_MAX_AGE_SECONDS) },
  );
}

function zUuid(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success)
    throw new ApiError(422, 'invalid_device_id', 'Invalid device ID');
  return result.data;
}
