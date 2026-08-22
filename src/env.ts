import { z } from 'zod';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PRESSAY_DEPLOYMENT_ENV: z
      .enum(['development', 'staging', 'production'])
      .default('development'),
    DATABASE_URL: z.url().startsWith('postgresql://'),
    DATABASE_URL_UNPOOLED: z.url().startsWith('postgresql://').optional(),
    PRESSAY_ALLOWED_ORIGINS: z.string().default('http://localhost:1420'),
    PRESSAY_API_URL: z.url().default('http://localhost:3000'),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    PRESSAY_BETTER_AUTH_JWT_ISSUER: z.url().optional(),
    PRESSAY_BETTER_AUTH_JWT_AUDIENCE: z
      .string()
      .min(1)
      .default('https://api.press-say.app'),
    PRESSAY_BETTER_AUTH_JWKS_URL: z.url().optional(),
    PRESSAY_INTERNAL_JWT_ISSUER: z.url().default('https://press-say.app/internal'),
    PRESSAY_INTERNAL_JWT_SECRET: z.string().min(32).optional(),
    DEVICE_IDENTIFIER_HMAC_SECRET: z.string().min(32).optional(),
    RATE_LIMIT_HMAC_SECRET: z.string().min(32).optional(),
    CRON_SECRET: z.string().min(32).optional(),
    PRESSAY_CLOUD_PROCESSING_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    PRESSAY_CLOUD_ACCOUNT_RATE_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(60),
    PRESSAY_CLOUD_DEVICE_RATE_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(30),
    PRESSAY_CLOUD_IP_RATE_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(120),
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
    APP_STORE_ISSUER_ID: z.uuid().optional(),
    APP_STORE_KEY_ID: z.string().min(1).max(64).optional(),
    APP_STORE_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
    APP_STORE_APP_APPLE_ID: z.coerce.number().int().positive().optional(),
    APP_STORE_PRODUCT_PRO_MONTHLY: z.string().min(1).max(255).optional(),
    APP_STORE_PRODUCT_PRO_ANNUAL: z.string().min(1).max(255).optional(),
    OPENAI_API_KEY: z.string().startsWith('sk-').optional(),
    OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
    OPENAI_TRANSFORM_MODEL: z.string().default('gpt-5-mini-2025-08-07'),
    OPENAI_TRANSCRIPTION_MODEL: z.string().default('gpt-4o-mini-transcribe-2025-12-15'),
    OPENAI_TRANSFORM_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(45_000),
    OPENAI_TRANSCRIPTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(180_000)
      .default(120_000),
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^(sk|rk)_(test|live)_/)
      .optional(),
    STRIPE_EXPECTED_ACCOUNT_ID: z
      .string()
      .regex(/^acct_[A-Za-z0-9]+$/)
      .optional(),
    STRIPE_COMMERCIAL_LAUNCH_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    PRESSAY_PRO_CURRENCY: z
      .string()
      .regex(/^[a-z]{3}$/)
      .default('eur'),
    PRESSAY_PRO_MONTHLY_AMOUNT_MINOR: z.coerce.number().int().positive().default(799),
    PRESSAY_PRO_ANNUAL_AMOUNT_MINOR: z.coerce.number().int().positive().default(6900),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
    STRIPE_PRODUCT_PRO: z.string().startsWith('prod_').optional(),
    STRIPE_PRICE_PRO_MONTHLY: z.string().startsWith('price_').optional(),
    STRIPE_PRICE_PRO_ANNUAL: z.string().startsWith('price_').optional(),
    STRIPE_CHECKOUT_SUCCESS_URL: z
      .url()
      .default('https://press-say.app/account?checkout=success'),
    STRIPE_CHECKOUT_CANCEL_URL: z
      .url()
      .default('https://press-say.app/pricing?checkout=cancelled'),
    STRIPE_PORTAL_RETURN_URL: z.url().default('https://press-say.app/account'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((environment, context) => {
    if (
      Boolean(environment.PRESSAY_BETTER_AUTH_JWT_ISSUER) !==
      Boolean(environment.PRESSAY_BETTER_AUTH_JWKS_URL)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PRESSAY_BETTER_AUTH_JWKS_URL'],
        message: 'Better Auth issuer and JWKS URL must be configured together',
      });
    }
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
