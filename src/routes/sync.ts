import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  appendSyncChangesRequestSchema,
  approveSyncDeviceRequestSchema,
  beginSyncRecoveryRequestSchema,
  completeSyncRecoveryRequestSchema,
  configureSyncRecoveryRequestSchema,
  enrollSyncDeviceRequestSchema,
  syncDeviceEnvelopeResponseSchema,
  syncDeviceListResponseSchema,
  syncRecoveryEnvelopeResponseSchema,
} from '../contracts/sync.js';
import { requireAuthentication } from '../lib/auth-middleware.js';
import { ApiError } from '../lib/errors.js';
import {
  appendSyncChanges,
  approveSyncDevice,
  beginSyncRecovery,
  completeSyncRecovery,
  configureSyncRecovery,
  deleteSyncRecovery,
  enrollSyncDevice,
  getSyncChanges,
  getSyncDeviceEnvelope,
  listSyncDevices,
} from '../services/sync.js';
import type { AppEnvironment } from '../types.js';

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

syncRoutes.get('/sync/devices', async (context) => {
  const approverDeviceId = parseUuid(context.req.query('approverDeviceId') ?? '');
  return context.json(
    syncDeviceListResponseSchema.parse({
      devices: await listSyncDevices(context.get('authUserId'), approverDeviceId),
    }),
  );
});

syncRoutes.get('/sync/devices/:id/envelope', async (context) => {
  return context.json(
    syncDeviceEnvelopeResponseSchema.parse(
      await getSyncDeviceEnvelope(
        context.get('authUserId'),
        parseUuid(context.req.param('id')),
      ),
    ),
  );
});

syncRoutes.put(
  '/sync/recovery',
  zValidator('json', configureSyncRecoveryRequestSchema, rejectInvalid),
  async (context) => {
    const input = context.req.valid('json');
    await configureSyncRecovery(
      context.get('authUserId'),
      input.deviceId,
      input.codeHash,
      input.encryptedAccountKey,
    );
    return context.body(null, 204);
  },
);

syncRoutes.delete('/sync/recovery', async (context) => {
  const deviceId = parseUuid(context.req.query('deviceId') ?? '');
  await deleteSyncRecovery(context.get('authUserId'), deviceId);
  return context.body(null, 204);
});

syncRoutes.post(
  '/sync/recovery/begin',
  zValidator('json', beginSyncRecoveryRequestSchema, rejectInvalid),
  async (context) => {
    const input = context.req.valid('json');
    return context.json(
      syncRecoveryEnvelopeResponseSchema.parse(
        await beginSyncRecovery(
          context.get('authUserId'),
          input.deviceId,
          input.publicKey,
          input.codeHash,
        ),
      ),
    );
  },
);

syncRoutes.post(
  '/sync/recovery/complete',
  zValidator('json', completeSyncRecoveryRequestSchema, rejectInvalid),
  async (context) => {
    const input = context.req.valid('json');
    await completeSyncRecovery(
      context.get('authUserId'),
      input.deviceId,
      input.codeHash,
      input.encryptedAccountKey,
    );
    return context.body(null, 204);
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
