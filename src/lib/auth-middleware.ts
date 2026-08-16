import { createMiddleware } from 'hono/factory';

import { getAuth } from '../auth.ts';
import type { AppEnvironment } from '../types.ts';
import { ApiError } from './errors.ts';

export const requireAuthentication = createMiddleware<AppEnvironment>(
  async (context, next) => {
    const authSession = await getAuth().api.getSession({
      headers: context.req.raw.headers,
    });
    if (!authSession) {
      throw new ApiError(401, 'unauthorized', 'Authentication required');
    }

    context.set('authUserId', authSession.user.id);
    context.set('authEmail', authSession.user.email);
    await next();
  },
);
