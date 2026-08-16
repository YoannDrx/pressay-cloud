import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  bootstrapAccountRequestSchema,
  bootstrapAccountResponseSchema,
  deviceListResponseSchema,
} from '../contracts/account.ts';
import { getAuth } from '../auth.ts';
import { requireAuthentication } from '../lib/auth-middleware.ts';
import { ApiError } from '../lib/errors.ts';
import {
  bootstrapAccount,
  getMe,
  getUsage,
  listDevices,
  requestAccountDeletion,
  revokeDevice,
} from '../services/accounts.ts';
import type { AppEnvironment } from '../types.ts';

export const accountRoutes = new Hono<AppEnvironment>();

accountRoutes.use('/accounts/*', requireAuthentication);
accountRoutes.use('/me', requireAuthentication);
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

accountRoutes.get('/me', async (context) => {
  return context.json(await getMe(context.get('authUserId'), context.get('authEmail')));
});

accountRoutes.delete('/me', async (context) => {
  await requestAccountDeletion(context.get('authUserId'));
  await getAuth().api.revokeSessions({ headers: context.req.raw.headers });
  return context.body(null, 202);
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
  const me = await getMe(context.get('authUserId'), context.get('authEmail'));
  return context.json({ entitlement: me.entitlement });
});

accountRoutes.get('/usage', async (context) => {
  return context.json(await getUsage(context.get('authUserId')));
});

function zUuid(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success)
    throw new ApiError(422, 'invalid_device_id', 'Invalid device ID');
  return result.data;
}
