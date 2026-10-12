import { Hono } from 'hono';

import { getEnvironment } from '../env.js';
import { ApiError } from '../lib/errors.js';
import type { AppEnvironment } from '../types.js';

/**
 * Pressay has one end-user identity issuer: the web app's Better Auth OAuth 2.1
 * server. The desktop signs in with authorization code + PKCE against that
 * issuer for every provider (Apple, Google and the web's other methods) and
 * presents the resulting access token to this API. The API itself no longer
 * runs social or magic-link sign-in.
 */
const DESKTOP_REDIRECT_URI = 'pressay://oauth/callback';

export const desktopAuthRoutes = new Hono<AppEnvironment>();

desktopAuthRoutes.get('/desktop-auth/config', (context) => {
  const environment = getEnvironment();
  const issuer =
    environment.PRESSAY_BETTER_AUTH_JWT_ISSUER?.replace(/\/+$/, '') ?? null;
  context.header('Cache-Control', 'public, max-age=300');
  return context.json({
    // Kept for older desktop builds: Cloud-native magic links are retired.
    magicLink: false,
    providers: ['apple', 'google'],
    callbackUrl: DESKTOP_REDIRECT_URI,
    flow: 'web_oauth_pkce',
    issuer,
    authorizationServerMetadataUrl: issuer
      ? `${issuer}/.well-known/oauth-authorization-server`
      : null,
    clientId: environment.PRESSAY_DESKTOP_OAUTH_CLIENT_ID,
    resource:
      environment.PRESSAY_BETTER_AUTH_JWT_AUDIENCE.split(',')[0]?.trim() ?? null,
    providerHintParameter: 'provider',
  });
});

function retired(): never {
  throw new ApiError(
    410,
    'desktop_auth_moved_to_web',
    'Sign in through the Pressay web identity provider',
  );
}

// The Cloud-hosted Better Auth instance (Apple/Google social sign-in, magic
// link and one-time desktop tokens) is retired. Answer old clients cleanly.
desktopAuthRoutes.get('/desktop-auth/social/*', retired);
desktopAuthRoutes.get('/desktop-auth/callback', retired);
desktopAuthRoutes.get('/desktop-auth/error', retired);
desktopAuthRoutes.on(['GET', 'POST'], '/auth/*', retired);
