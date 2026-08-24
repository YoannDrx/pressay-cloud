const baseUrl = (
  process.env.PRESSAY_STAGING_BASE_URL ?? 'https://api-staging.press-say.app'
).replace(/\/$/, '');
const expectedCloudAuthProviders = (
  process.env.PRESSAY_EXPECTED_CLOUD_AUTH_PROVIDERS ??
  process.env.PRESSAY_EXPECTED_AUTH_PROVIDERS ??
  'google,apple'
)
  .split(',')
  .map((provider) => provider.trim())
  .filter(Boolean);
const expectedAuthCallbackUrl =
  process.env.PRESSAY_EXPECTED_AUTH_CALLBACK_URL ??
  `${baseUrl}/v1/desktop-auth/callback`;
const deploymentToken = process.env.PRESSAY_STAGING_AUTOMATION_BYPASS_SECRET;
const oauthIssuer = (
  process.env.PRESSAY_OAUTH_ISSUER ?? 'https://press-say.app'
).replace(/\/$/, '');
const expectedEntitlementPublicKey =
  process.env.PRESSAY_EXPECTED_ENTITLEMENT_PUBLIC_KEY ??
  'gj3woVSEMEiNemiZKdA28oEvMrLL9iQPbiMPr_B-plQ';

interface Check {
  name: string;
  url: string;
  expected: number[];
  validate?: (body: unknown) => boolean;
}
const checks: Check[] = [
  {
    name: 'process health',
    url: `${baseUrl}/v1/health`,
    expected: [200],
    validate: (body) => (body as { status?: string }).status === 'ok',
  },
  {
    name: 'database readiness',
    url: `${baseUrl}/v1/ready`,
    expected: [200],
    validate: (body) => (body as { status?: string }).status === 'ready',
  },
  {
    name: 'desktop auth configuration',
    url: `${baseUrl}/v1/desktop-auth/config`,
    expected: [200],
    validate: (body) => {
      const config = body as {
        magicLink?: unknown;
        providers?: unknown;
        callbackUrl?: unknown;
      };
      return (
        typeof config.magicLink === 'boolean' &&
        Array.isArray(config.providers) &&
        typeof config.callbackUrl === 'string' &&
        config.callbackUrl === expectedAuthCallbackUrl
      );
    },
  },
  ...expectedCloudAuthProviders.map((provider): Check => ({
    name: `Cloud-native auth provider: ${provider}`,
    url: `${baseUrl}/v1/desktop-auth/config`,
    expected: [200],
    validate: (body) => {
      const providers = (body as { providers?: unknown }).providers;
      return Array.isArray(providers) && providers.includes(provider);
    },
  })),
  {
    name: 'OAuth 2.1 PKCE issuer',
    url: `${oauthIssuer}/.well-known/oauth-authorization-server`,
    expected: [200],
    validate: (body) => {
      const metadata = body as {
        issuer?: unknown;
        authorization_endpoint?: unknown;
        token_endpoint?: unknown;
        grant_types_supported?: unknown;
        code_challenge_methods_supported?: unknown;
      };
      return (
        metadata.issuer === oauthIssuer &&
        metadata.authorization_endpoint ===
          `${oauthIssuer}/api/auth/oauth2/authorize` &&
        metadata.token_endpoint === `${oauthIssuer}/api/auth/oauth2/token` &&
        Array.isArray(metadata.grant_types_supported) &&
        metadata.grant_types_supported.includes('authorization_code') &&
        metadata.grant_types_supported.includes('refresh_token') &&
        Array.isArray(metadata.code_challenge_methods_supported) &&
        metadata.code_challenge_methods_supported.includes('S256')
      );
    },
  },
  {
    name: 'entitlement signing key',
    url: `${baseUrl}/v1/entitlements/jwks`,
    expected: [200],
    validate: (body) => {
      const keys = (body as { keys?: unknown }).keys;
      if (!Array.isArray(keys) || keys.length !== 1) return false;
      const key = keys[0] as Record<string, unknown>;
      return (
        key.kty === 'OKP' &&
        key.crv === 'Ed25519' &&
        key.alg === 'EdDSA' &&
        key.use === 'sig' &&
        key.kid === 'pressay-entitlement-2026-01' &&
        key.x === expectedEntitlementPublicKey &&
        !('d' in key)
      );
    },
  },
  {
    name: 'entitlements require authentication',
    url: `${baseUrl}/v1/entitlements`,
    expected: [401],
  },
  {
    name: 'sync requires authentication',
    url: `${baseUrl}/v1/sync/devices`,
    expected: [401],
  },
];

let failed = false;
for (const check of checks) {
  const headers = new Headers({ Accept: 'application/json' });
  if (deploymentToken) headers.set('x-vercel-protection-bypass', deploymentToken);
  const started = performance.now();
  try {
    const response = await fetch(check.url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    let body: unknown = null;
    if (response.headers.get('content-type')?.includes('application/json'))
      body = await response.json();
    const ok =
      check.expected.includes(response.status) &&
      (!check.validate || check.validate(body));
    failed ||= !ok;
    console.log(
      JSON.stringify({
        check: check.name,
        ok,
        status: response.status,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  } catch (error) {
    failed = true;
    console.log(
      JSON.stringify({
        check: check.name,
        ok: false,
        error: error instanceof Error ? error.name : 'ProbeError',
      }),
    );
  }
}

if (failed) process.exitCode = 1;
