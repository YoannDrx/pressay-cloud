import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url().startsWith('postgresql://'),
  DATABASE_URL_UNPOOLED: z.url().startsWith('postgresql://').optional(),
  PRESSAY_ALLOWED_ORIGINS: z.string().default('http://localhost:1420'),
  PRESSAY_API_URL: z.url().default('http://localhost:3000'),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  DEVICE_IDENTIFIER_HMAC_SECRET: z.string().min(32).optional(),
  ENTITLEMENT_SIGNING_PRIVATE_KEY: z.string().min(1).optional(),
  ENTITLEMENT_SIGNING_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,80}$/)
    .default('pressay-entitlement-development'),
  RESEND_API_KEY: z.string().startsWith('re_').optional(),
  PRESSAY_AUTH_FROM_EMAIL: z.string().default('Pressay <account@press-say.app>'),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  APPLE_CLIENT_ID: z.string().min(1).optional(),
  APPLE_TEAM_ID: z.string().min(1).optional(),
  APPLE_KEY_ID: z.string().min(1).optional(),
  APPLE_PRIVATE_KEY: z.string().min(1).optional(),
  APPLE_APP_BUNDLE_IDENTIFIER: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Environment = z.infer<typeof environmentSchema> & {
  allowedOrigins: readonly string[];
};

let cachedEnvironment: Environment | undefined;

export function getEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  if (source === process.env && cachedEnvironment) return cachedEnvironment;

  const parsed = environmentSchema.parse(source);
  const allowedOrigins = parsed.PRESSAY_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).origin);

  if (allowedOrigins.length === 0) {
    throw new Error('PRESSAY_ALLOWED_ORIGINS must contain at least one origin');
  }

  const environment = Object.freeze({ ...parsed, allowedOrigins });
  if (source === process.env) cachedEnvironment = environment;
  return environment;
}

export function clearEnvironmentCacheForTests(): void {
  cachedEnvironment = undefined;
}

export function requireEnvironmentValue(
  value: string | undefined,
  name: string,
): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
