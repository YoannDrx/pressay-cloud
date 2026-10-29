import { Hono } from 'hono';

import { downloadEventSchema } from '../contracts/downloads.js';
import { requireDownloadEventToken } from '../lib/auth-middleware.js';
import { ApiError } from '../lib/errors.js';
import { recordDownloadEvent } from '../services/downloads.js';
import type { AppEnvironment } from '../types.js';

export const downloadRoutes = new Hono<AppEnvironment>();

downloadRoutes.post('/downloads', requireDownloadEventToken, async (context) => {
  const result = downloadEventSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!result.success)
    throw new ApiError(422, 'invalid_request', 'Check the submitted fields');
  await recordDownloadEvent(result.data);
  return context.json({ recorded: true }, 202);
});
