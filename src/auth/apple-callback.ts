import { serializeSignedCookie } from 'better-call';
import { z } from 'zod';

import { getSql } from '../db/client.js';
import { getEnvironment, requireEnvironmentValue } from '../env.js';

const appleProviderStateSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const stateCookieName = '__Secure-better-auth.state';

const verificationRowSchema = z.object({ value: z.string() });
const storedStateSchema = z.object({
  callbackURL: z.url(),
  oauthState: appleProviderStateSchema,
});

function isDesktopCallback(value: string): boolean {
  const environment = getEnvironment();
  const callback = new URL(value);
  const expected = new URL('/v1/desktop-auth/callback', environment.PRESSAY_API_URL);
  const callbackStates = callback.searchParams.getAll('state');
  return (
    callback.origin === expected.origin &&
    callback.pathname === expected.pathname &&
    !callback.username &&
    !callback.password &&
    !callback.hash &&
    [...callback.searchParams.keys()].every((key) => key === 'state') &&
    callbackStates.length === 1 &&
    appleProviderStateSchema.safeParse(callbackStates[0]).success
  );
}

async function isPersistedDesktopState(state: string): Promise<boolean> {
  try {
    const rows = await getSql().query(
      `SELECT value
       FROM verification
       WHERE identifier = $1
         AND "expiresAt" > now()
       ORDER BY "createdAt" DESC
       LIMIT 1`,
      [state],
    );
    const row = verificationRowSchema.safeParse(rows[0]);
    if (!row.success) return false;
    const stored = storedStateSchema.safeParse(JSON.parse(row.data.value));
    return (
      stored.success &&
      stored.data.oauthState === state &&
      isDesktopCallback(stored.data.callbackURL)
    );
  } catch {
    // Fall through to Better Auth's normal state validation. A transient DB
    // failure must never relax the callback or reveal verification contents.
    return false;
  }
}

function replaceStateCookie(existing: string | null, signedCookie: string): string {
  const cookies = (existing ?? '')
    .split(';')
    .map((cookie) => cookie.trim())
    .filter(Boolean)
    .filter((cookie) => !cookie.startsWith(`${stateCookieName}=`));
  cookies.push(signedCookie);
  return cookies.join('; ');
}

/**
 * Better Auth converts Apple's cross-site form POST into a same-origin GET
 * before it validates OAuth state. Some browsers still omit the short-lived
 * state cookie on that redirected GET. Re-sign only the provider state on this
 * dedicated callback request; Better Auth still requires the matching,
 * unexpired, single-use verification row before it exchanges the authorization
 * code.
 */
export async function restoreAppleCallbackStateCookie(
  request: Request,
): Promise<Request> {
  if (request.method !== 'GET') return request;

  const state = appleProviderStateSchema.safeParse(
    new URL(request.url).searchParams.get('state'),
  );
  if (!state.success) return request;
  if (!(await isPersistedDesktopState(state.data))) return request;

  const environment = getEnvironment();
  const serialized = await serializeSignedCookie(
    'better-auth.state',
    state.data,
    requireEnvironmentValue(environment.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET'),
    {
      httpOnly: true,
      path: '/',
      prefix: 'secure',
      sameSite: 'none',
      secure: true,
    },
  );
  const signedCookie = serialized.split(';', 1)[0];
  if (!signedCookie?.startsWith(`${stateCookieName}=`)) return request;

  const headers = new Headers(request.headers);
  headers.set('cookie', replaceStateCookie(headers.get('cookie'), signedCookie));
  return new Request(request, { headers });
}
