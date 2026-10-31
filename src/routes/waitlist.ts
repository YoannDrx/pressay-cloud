import { Hono } from 'hono';

import { waitlistSignupSchema } from '../contracts/waitlist.js';
import { waitlistClientAddress } from '../lib/auth-middleware.js';
import { getClientIp } from '../lib/client-ip.js';
import { ApiError } from '../lib/errors.js';
import { consume } from '../services/rate-limits.js';
import { joinWaitlist } from '../services/waitlist.js';
import type { AppEnvironment } from '../types.js';

export const waitlistRoutes = new Hono<AppEnvironment>();

/** Sign-ups per visitor address and minute. */
const SIGNUPS_PER_MINUTE = 5;

/**
 * Public platform waitlist sign-up. The answer is the same whether the
 * address is new, already listed or unsubscribed, so it cannot be used to
 * test addresses. Nothing about the request is logged.
 */
waitlistRoutes.post('/waitlist', async (context) => {
  const vouched = await waitlistClientAddress(
    context.req.header('authorization'),
    context.get('requestId'),
  );
  await consume('waitlist_signup', vouched ?? getClientIp(context), SIGNUPS_PER_MINUTE);
  const signup = waitlistSignupSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!signup.success)
    throw new ApiError(422, 'invalid_request', 'Check the address and the consent');
  await joinWaitlist(signup.data);
  context.header('Cache-Control', 'no-store');
  return context.json({ status: 'registered' }, 202);
});
