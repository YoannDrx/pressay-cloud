import { operationsRoutes } from './routes/operations.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { matchedRoutes } from 'hono/route';
import { secureHeaders } from 'hono/secure-headers';

import { parseAllowedOrigins } from './env.js';
import { errorCauseChain, publicApiError, stableErrorCode } from './lib/errors.js';
import { writeLog } from './lib/logger.js';
import { requestId } from './lib/request-id.js';
import { healthRoutes } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { accountRoutes } from './routes/accounts.js';
import { billingRoutes } from './routes/billing.js';
import { cloudRoutes } from './routes/cloud.js';
import { desktopAuthRoutes } from './routes/desktop-auth.js';
import { syncRoutes } from './routes/sync.js';
import type { AppEnvironment } from './types.js';

const app = new Hono<AppEnvironment>();

app.use('*', secureHeaders());
app.use('*', requestId);
let originCache: { raw: string; origins: ReadonlySet<string> } | undefined;

/**
 * Read the allowlist without requiring the full environment (health checks
 * must answer even when the database URL is missing). Invalid entries are
 * dropped here; getEnvironment() rejects them at the first real request.
 */
function allowedOrigins(): ReadonlySet<string> {
  const raw = process.env.PRESSAY_ALLOWED_ORIGINS ?? 'http://localhost:1420';
  if (originCache?.raw !== raw) {
    const origins = new Set<string>();
    for (const entry of raw.split(',')) {
      try {
        for (const origin of parseAllowedOrigins(entry)) origins.add(origin);
      } catch {
        // Ignored: not a URL.
      }
    }
    originCache = { raw, origins };
  }
  return originCache.origins;
}

app.use(
  '/v1/*',
  cors({
    origin: (origin) => (allowedOrigins().has(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Device-Id'],
    exposeHeaders: ['Content-Length', 'X-Request-Id', 'Retry-After'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 600,
  }),
);

app.route('/v1', healthRoutes);
app.route('/v1', internalRoutes);
app.route('/v1', accountRoutes);
app.route('/v1', operationsRoutes);
app.route('/v1', billingRoutes);
app.route('/v1', cloudRoutes);
app.route('/v1', desktopAuthRoutes);
app.route('/v1', syncRoutes);

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
  const apiError = publicApiError(error);
  const status = apiError?.status ?? 500;
  const code = apiError?.code ?? 'internal_error';

  // Names and stable codes only: provider and database messages can carry
  // customer data or credentials. The route is the registered pattern, never
  // the raw path, so identifiers in URLs stay out of the logs.
  let route = 'unknown';
  try {
    // The endpoint is the matched route registered for a concrete method;
    // `ALL` entries are middleware such as CORS or authentication.
    route =
      matchedRoutes(context).findLast((candidate) => candidate.method !== 'ALL')
        ?.path ?? 'unknown';
  } catch {
    // No matched route.
  }
  writeLog(status >= 500 ? 'error' : 'warn', 'request.failed', {
    code,
    error_code: stableErrorCode(error),
    error_name: errorCauseChain(error, 1) || 'unknown',
    cause_chain: errorCauseChain(error),
    method: context.req.method,
    route,
    request_id: requestId,
    status,
  });

  for (const [name, value] of Object.entries(apiError?.headers ?? {})) {
    context.header(name, value);
  }
  return context.json(
    {
      error: {
        ...(apiError?.details ?? {}),
        code,
        message: apiError?.message ?? 'An unexpected error occurred',
      },
      requestId,
    },
    status,
  );
});

export default app;
