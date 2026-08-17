import { Hono } from 'hono';

import { databaseIsReady } from '../db/health.js';
import { healthResponseSchema, readyResponseSchema } from '../contracts/health.js';

export const healthRoutes = new Hono()
  .get('/health', (context) => {
    return context.json(
      healthResponseSchema.parse({
        status: 'ok',
        service: 'pressay-cloud',
        version: process.env.VERCEL_GIT_COMMIT_SHA ?? 'development',
      }),
    );
  })
  .get('/ready', async (context) => {
    const ready = await databaseIsReady();
    return context.json(
      readyResponseSchema.parse({
        status: ready ? 'ready' : 'unavailable',
        checks: { database: ready ? 'up' : 'down' },
      }),
      ready ? 200 : 503,
    );
  });
