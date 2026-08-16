import { serve } from '@hono/node-server';

import app from './app.ts';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    JSON.stringify({
      event: 'server.started',
      level: 'info',
      port: info.port,
      timestamp: new Date().toISOString(),
    }),
  );
});
