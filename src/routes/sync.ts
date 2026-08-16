import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  appendSyncChangesRequestSchema,
  approveSyncDeviceRequestSchema,
  enrollSyncDeviceRequestSchema,
} from '../contracts/sync.ts';
import { requireAuthentication } from '../lib/auth-middleware.ts';
import { ApiError } from '../lib/errors.ts';
import {
  appendSyncChanges,
  approveSyncDevice,
  enrollSyncDevice,
  getSyncChanges,
} from '../services/sync.ts';
import type { AppEnvironment } from '../types.ts';

export const syncRoutes = new Hono<AppEnvironment>();
syncRoutes.use('/sync/*', requireAuthentication);

syncRoutes.post(
  '/sync/devices/enroll',
  zValidator('json', enrollSyncDeviceRequestSchema, rejectInvalid),
  async (context) => {
    const input = context.req.valid('json');
    const status = await enrollSyncDevice(
      context.get('authUserId'),
      input.deviceId,
      input.publicKey,
      input.encryptedAccountKey,
    );
    return context.json({ status }, status === 'approved' ? 201 : 202);
  },
);

syncRoutes.post(
  '/sync/devices/:id/approve',
  zValidator('json', approveSyncDeviceRequestSchema, rejectInvalid),
  async (context) => {
    const targetDeviceId = parseUuid(context.req.param('id'));
    const input = context.req.valid('json');
    await approveSyncDevice(
      context.get('authUserId'),
      targetDeviceId,
      input.approverDeviceId,
      input.encryptedAccountKey,
    );
    return context.body(null, 204);
  },
);

syncRoutes.post(
  '/sync/changes',
  zValidator('json', appendSyncChangesRequestSchema, rejectInvalid),
  async (context) => {
    const input = context.req.valid('json');
    return context.json(
      await appendSyncChanges(context.get('authUserId'), input.deviceId, input.changes),
      201,
    );
  },
);

syncRoutes.get('/sync/changes', async (context) => {
  const query = z
    .object({
      deviceId: z.uuid(),
      after: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    })
    .safeParse(context.req.query());
  if (!query.success) throw new ApiError(422, 'invalid_request', 'Invalid sync query');
  return context.json(
    await getSyncChanges(
      context.get('authUserId'),
      query.data.deviceId,
      query.data.after,
      query.data.limit,
    ),
  );
});

function rejectInvalid(result: { success: boolean }): void {
  if (!result.success)
    throw new ApiError(422, 'invalid_request', 'Invalid sync request');
}

function parseUuid(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success)
    throw new ApiError(422, 'invalid_device_id', 'Invalid device ID');
  return result.data;
}
