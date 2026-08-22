import { Hono } from 'hono';

import { databaseReadiness } from '../db/health.js';
import { healthResponseSchema, readyResponseSchema } from '../contracts/health.js';

export const healthRoutes = new Hono()
  .get('/health', (context) => {
    return context.json(
      healthResponseSchema.parse({
        status: 'ok',
        service: 'pressay-cloud',
        version: process.env.VERCEL_GIT_COMMIT_SHA ?? 'development',
        environment: process.env.PRESSAY_DEPLOYMENT_ENV ?? 'development',
      }),
    );
  })
  .get('/ready', async (context) => {
    const readiness = await databaseReadiness();
    return context.json(
      readyResponseSchema.parse({
        status: readiness.ready ? 'ready' : 'unavailable',
        checks: {
          database: readiness.ready ? 'up' : 'down',
          schemaVersion: readiness.schemaVersion,
        },
      }),
      readiness.ready ? 200 : 503,
    );
  });
