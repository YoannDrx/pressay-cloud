import type { Context, MiddlewareHandler } from 'hono';

import { getEnvironment } from '../env.js';
import { consume } from '../services/rate-limits.js';
import type { AppEnvironment } from '../types.js';
import { getClientIp } from './client-ip.js';

type RateLimitKey = 'user' | 'ip';

function identifier(context: Context<AppEnvironment>, key: RateLimitKey): string {
  return key === 'user' ? context.get('authUserId') : getClientIp(context);
}

/**
 * Fixed one-minute window per scope, keyed by the authenticated user or the
 * client IP. Identifiers are HMAC-hashed before storage. Local development
 * without RATE_LIMIT_HMAC_SECRET skips the limit; every deployed environment
 * must configure the secret (a missing secret fails closed with a 500).
 */
export function rateLimit(
  scope: string,
  limitPerMinute: number,
  key: RateLimitKey = 'user',
): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const environment = getEnvironment();
    if (
      environment.PRESSAY_DEPLOYMENT_ENV === 'development' &&
      !environment.RATE_LIMIT_HMAC_SECRET
    ) {
      await next();
      return;
    }
    await consume(scope, identifier(context, key), limitPerMinute);
    await next();
  };
}
