import pg from 'pg';
import { betterAuth } from 'better-auth';
import { bearer, magicLink } from 'better-auth/plugins';

import { generateAppleClientSecret } from './auth/apple.ts';
import { sendMagicLinkEmail } from './email/magic-link.ts';
import { getEnvironment, requireEnvironmentValue } from './env.ts';

function requireCompletePair(
  first: string | undefined,
  second: string | undefined,
  names: readonly [string, string],
): void {
  if (Boolean(first) !== Boolean(second)) {
    throw new Error(`${names[0]} and ${names[1]} must be configured together`);
  }
}

function buildAuth() {
  const environment = getEnvironment();
  requireCompletePair(environment.GOOGLE_CLIENT_ID, environment.GOOGLE_CLIENT_SECRET, [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ]);

  const appleValues = [
    environment.APPLE_CLIENT_ID,
    environment.APPLE_TEAM_ID,
    environment.APPLE_KEY_ID,
    environment.APPLE_PRIVATE_KEY,
  ];
  if (appleValues.some(Boolean) && !appleValues.every(Boolean)) {
    throw new Error('All Apple OAuth credentials must be configured together');
  }

  const pool = new pg.Pool({ connectionString: environment.DATABASE_URL, max: 5 });
  const socialProviders = {
    ...(environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: environment.GOOGLE_CLIENT_ID,
            clientSecret: environment.GOOGLE_CLIENT_SECRET,
            prompt: 'select_account' as const,
          },
        }
      : {}),
    ...(environment.APPLE_CLIENT_ID &&
    environment.APPLE_TEAM_ID &&
    environment.APPLE_KEY_ID &&
    environment.APPLE_PRIVATE_KEY
      ? {
          apple: async () => ({
            clientId: requireEnvironmentValue(
              environment.APPLE_CLIENT_ID,
              'APPLE_CLIENT_ID',
            ),
            clientSecret: await generateAppleClientSecret(
              requireEnvironmentValue(environment.APPLE_CLIENT_ID, 'APPLE_CLIENT_ID'),
              requireEnvironmentValue(environment.APPLE_TEAM_ID, 'APPLE_TEAM_ID'),
              requireEnvironmentValue(environment.APPLE_KEY_ID, 'APPLE_KEY_ID'),
              requireEnvironmentValue(
                environment.APPLE_PRIVATE_KEY,
                'APPLE_PRIVATE_KEY',
              ),
            ),
            ...(environment.APPLE_APP_BUNDLE_IDENTIFIER
              ? { appBundleIdentifier: environment.APPLE_APP_BUNDLE_IDENTIFIER }
              : {}),
          }),
        }
      : {}),
  };

  return betterAuth({
    appName: 'Pressay',
    baseURL: environment.PRESSAY_API_URL,
    basePath: '/v1/auth',
    secret: requireEnvironmentValue(
      environment.BETTER_AUTH_SECRET,
      'BETTER_AUTH_SECRET',
    ),
    database: pool,
    trustedOrigins: [
      ...environment.allowedOrigins,
      'pressay://',
      'https://appleid.apple.com',
    ],
    socialProviders,
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 12,
      freshAge: 60 * 10,
      deferSessionRefresh: true,
    },
    verification: { storeInDatabase: true },
    plugins: [
      magicLink({
        expiresIn: 60 * 10,
        storeToken: 'hashed',
        sendMagicLink: ({ email, url }) => sendMagicLinkEmail({ email, url }),
      }),
      bearer({ requireSignature: true }),
    ],
  });
}

type AuthInstance = ReturnType<typeof buildAuth>;
let authInstance: AuthInstance | undefined;

export function getAuth(): AuthInstance {
  authInstance ??= buildAuth();
  return authInstance;
}

export function clearAuthForTests(): void {
  authInstance = undefined;
}
