import { randomUUID } from 'node:crypto';

import { createMiddleware } from 'hono/factory';

const validRequestId = /^[A-Za-z0-9_-]{16,64}$/;

export const requestId = createMiddleware(async (context, next) => {
  const supplied = context.req.header('x-request-id');
  const id = supplied && validRequestId.test(supplied) ? supplied : randomUUID();
  context.set('requestId', id);
  await next();
  context.header('x-request-id', id);
});
