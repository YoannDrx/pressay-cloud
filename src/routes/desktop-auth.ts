import { Hono } from 'hono';
import { z } from 'zod';

import { getAuth } from '../auth.js';
import { getEnvironment } from '../env.js';
import { ApiError } from '../lib/errors.js';
import type { AppEnvironment } from '../types.js';

const desktopAuthStateSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const desktopAuthRoutes = new Hono<AppEnvironment>();

desktopAuthRoutes.get('/desktop-auth/config', (context) => {
  const environment = getEnvironment();
  return context.json({
    magicLink: Boolean(environment.RESEND_API_KEY),
    providers: [
      ...(environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET
        ? ['google' as const]
        : []),
      ...(environment.APPLE_CLIENT_ID &&
      environment.APPLE_TEAM_ID &&
      environment.APPLE_KEY_ID &&
      environment.APPLE_PRIVATE_KEY
        ? ['apple' as const]
        : []),
    ],
    callbackUrl: new URL(
      '/v1/desktop-auth/callback',
      environment.PRESSAY_API_URL,
    ).toString(),
  });
});

desktopAuthRoutes.get('/desktop-auth/callback', async (context) => {
  const state = desktopAuthStateSchema.safeParse(context.req.query('state'));
  if (!state.success) {
    throw new ApiError(422, 'invalid_auth_state', 'Invalid desktop auth state');
  }

  const auth = getAuth();
  const session = await auth.api.getSession({ headers: context.req.raw.headers });
  if (!session) {
    throw new ApiError(401, 'auth_session_required', 'Authentication required');
  }
  const result = await auth.api.generateOneTimeToken({
    headers: context.req.raw.headers,
  });
  const callback = new URL('pressay://oauth/callback');
  callback.hash = new URLSearchParams({
    token: result.token,
    state: state.data,
  }).toString();

  context.header('Cache-Control', 'no-store, max-age=0');
  context.header('Pragma', 'no-cache');
  context.header('Referrer-Policy', 'no-referrer');
  return context.redirect(callback.toString(), 302);
});
