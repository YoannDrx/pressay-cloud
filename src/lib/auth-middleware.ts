import { createMiddleware } from 'hono/factory';

import { getAuth } from '../auth.js';
import type { AppEnvironment } from '../types.js';
import { ApiError } from './errors.js';

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
