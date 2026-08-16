import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { ApiError } from './lib/errors.ts';
import { writeLog } from './lib/logger.ts';
import { requestId } from './lib/request-id.ts';
import { healthRoutes } from './routes/health.ts';
import { accountRoutes } from './routes/accounts.ts';
import type { AppEnvironment } from './types.ts';
import { getAuth } from './auth.ts';

const app = new Hono<AppEnvironment>();

app.use('*', secureHeaders());
app.use('*', requestId);
app.use(
  '/v1/*',
  cors({
    origin: (origin) => {
      const allowed = (process.env.PRESSAY_ALLOWED_ORIGINS ?? 'http://localhost:1420')
        .split(',')
        .map((value) => value.trim());
      return allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Device-Id'],
    exposeHeaders: ['Content-Length', 'X-Request-Id'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 600,
  }),
);

app.route('/v1', healthRoutes);
app.route('/v1', accountRoutes);
app.on(['GET', 'POST'], '/v1/auth/*', (context) => {
  return getAuth().handler(context.req.raw);
});

app.notFound((context) =>
  context.json(
    {
      error: { code: 'not_found', message: 'Route not found' },
      requestId: context.get('requestId'),
    },
    404,
  ),
);

app.onError((error, context) => {
  const requestId = context.get('requestId');
  const apiError = error instanceof ApiError ? error : undefined;
  const status = apiError?.status ?? 500;
  const code = apiError?.code ?? 'internal_error';

  writeLog('error', 'request.failed', {
    code,
    method: context.req.method,
    path: context.req.path,
    request_id: requestId,
    status,
  });

  return context.json(
    {
      error: {
        code,
        message: apiError?.message ?? 'An unexpected error occurred',
      },
      requestId,
    },
    status,
  );
});

export default app;
