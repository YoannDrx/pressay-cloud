import type { Context } from 'hono';

import type { AppEnvironment } from '../types.js';

export function getClientIp(context: Context<AppEnvironment>): string {
  const forwarded =
    context.req.header('x-vercel-forwarded-for') ??
    context.req.header('x-forwarded-for');
  const candidate = forwarded?.split(',')[0]?.trim();
  return candidate && candidate.length <= 64 ? candidate : 'unknown';
}
