const baseUrl = (
  process.env.PRESSAY_STAGING_BASE_URL ?? 'https://api-staging.press-say.app'
).replace(/\/$/, '');
const expectedAuthProviders = (
  process.env.PRESSAY_EXPECTED_AUTH_PROVIDERS ?? 'google,apple'
)
  .split(',')
  .map((provider) => provider.trim())
  .filter(Boolean);
const expectedAuthCallbackUrl =
  process.env.PRESSAY_EXPECTED_AUTH_CALLBACK_URL ??
  `${baseUrl}/v1/desktop-auth/callback`;
const deploymentToken = process.env.PRESSAY_STAGING_AUTOMATION_BYPASS_SECRET;
const expectedEntitlementPublicKey =
  process.env.PRESSAY_EXPECTED_ENTITLEMENT_PUBLIC_KEY ??
  'gj3woVSEMEiNemiZKdA28oEvMrLL9iQPbiMPr_B-plQ';

interface Check {
  name: string;
  path: string;
  expected: number[];
  validate?: (body: unknown) => boolean;
}
const checks: Check[] = [
  {
    name: 'process health',
    path: '/v1/health',
    expected: [200],
    validate: (body) => (body as { status?: string }).status === 'ok',
  },
  {
    name: 'database readiness',
    path: '/v1/ready',
    expected: [200],
    validate: (body) => (body as { status?: string }).status === 'ready',
  },
  {
    name: 'desktop auth configuration',
    path: '/v1/desktop-auth/config',
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
  ...expectedAuthProviders.map((provider): Check => ({
    name: `desktop auth provider: ${provider}`,
    path: '/v1/desktop-auth/config',
    expected: [200],
    validate: (body) => {
      const providers = (body as { providers?: unknown }).providers;
      return Array.isArray(providers) && providers.includes(provider);
    },
  })),
  {
    name: 'entitlement signing key',
    path: '/v1/entitlements/jwks',
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
    path: '/v1/entitlements',
    expected: [401],
  },
  { name: 'sync requires authentication', path: '/v1/sync/devices', expected: [401] },
];

let failed = false;
for (const check of checks) {
  const headers = new Headers({ Accept: 'application/json' });
  if (deploymentToken) headers.set('x-vercel-protection-bypass', deploymentToken);
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${check.path}`, {
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
