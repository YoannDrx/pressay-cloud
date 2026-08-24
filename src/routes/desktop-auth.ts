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

const socialSignInResponseSchema = z.object({
  redirect: z.boolean(),
  url: z.url(),
});

function desktopCallbackUrl(state: string): string {
  const environment = getEnvironment();
  const callback = new URL('/v1/desktop-auth/callback', environment.PRESSAY_API_URL);
  callback.searchParams.set('state', state);
  return callback.toString();
}

function desktopErrorUrl(state: string): string {
  const environment = getEnvironment();
  const callback = new URL('/v1/desktop-auth/error', environment.PRESSAY_API_URL);
  callback.searchParams.set('state', state);
  return callback.toString();
}

function validateAppleAuthorizationUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'appleid.apple.com' ||
    url.pathname !== '/auth/authorize' ||
    url.username ||
    url.password
  ) {
    throw new ApiError(
      503,
      'invalid_auth_provider_response',
      'Invalid Apple authorization response',
    );
  }
  return url.toString();
}

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

desktopAuthRoutes.get('/desktop-auth/social/apple', async (context) => {
  const state = desktopAuthStateSchema.safeParse(context.req.query('state'));
  if (!state.success) {
    throw new ApiError(422, 'invalid_auth_state', 'Invalid desktop auth state');
  }

  // Start the provider flow in the user's browser. Better Auth persists a
  // signed state cookie which Apple must return with its form_post callback;
  // starting this request from the native HTTP client loses that cookie jar.
  const response = await getAuth().api.signInSocial({
    body: {
      provider: 'apple',
      callbackURL: desktopCallbackUrl(state.data),
      errorCallbackURL: desktopErrorUrl(state.data),
      disableRedirect: true,
    },
    headers: context.req.raw.headers,
    asResponse: true,
  });
  if (!response.ok) {
    throw new ApiError(
      503,
      'auth_provider_unavailable',
      'Unable to start Apple authentication',
    );
  }
  const payload = (await response.json().catch(() => undefined)) as unknown;
  const parsed = socialSignInResponseSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.url) {
    throw new ApiError(
      503,
      'invalid_auth_provider_response',
      'Invalid Apple authorization response',
    );
  }

  const headers = new Headers({
    'Cache-Control': 'no-store, max-age=0',
    Location: validateAppleAuthorizationUrl(parsed.data.url),
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
  });
  const cookies = response.headers.getSetCookie();
  const hasUsableStateCookie = cookies.some(
    (cookie) =>
      cookie.startsWith('__Secure-better-auth.state=') &&
      /;\s*HttpOnly(?:;|$)/i.test(cookie) &&
      /;\s*Secure(?:;|$)/i.test(cookie) &&
      /;\s*SameSite=None(?:;|$)/i.test(cookie),
  );
  if (!hasUsableStateCookie) {
    throw new ApiError(
      503,
      'invalid_auth_provider_response',
      'Apple authentication state cookie is unavailable',
    );
  }
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
});

desktopAuthRoutes.get('/desktop-auth/error', (context) => {
  const state = desktopAuthStateSchema.safeParse(context.req.query('state'));
  if (!state.success) {
    throw new ApiError(422, 'invalid_auth_state', 'Invalid desktop auth state');
  }
  const callback = new URL('pressay://oauth/error');
  callback.searchParams.set('state', state.data);
  context.header('Cache-Control', 'no-store, max-age=0');
  context.header('Pragma', 'no-cache');
  context.header('Referrer-Policy', 'no-referrer');
  return context.redirect(callback.toString(), 302);
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
