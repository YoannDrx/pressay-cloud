/**
 * Proof of a recent sign-in or second factor, carried by web proxy tokens and
 * bound to the web session. Ten minutes matches the web session `freshAge`
 * (Better Auth refuses account deletion after it) and the admin step-up
 * lifetime: long enough to re-authenticate with Apple, Google or a passkey and
 * confirm, short enough that an old session cannot perform the action.
 */
export const RECENT_AUTHENTICATION_MAX_AGE_SECONDS = 10 * 60;

/** Tolerated clock drift between the web server and the API. */
const CLOCK_SKEW_SECONDS = 30;

export function isRecentAuthentication(
  at: number,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  return (
    Number.isFinite(at) &&
    at > now - RECENT_AUTHENTICATION_MAX_AGE_SECONDS &&
    at <= now + CLOCK_SKEW_SECONDS
  );
}
