import { createMiddleware } from 'hono/factory';
import {
  createRemoteJWKSet,
  decodeJwt,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from 'jose';

import { getEnvironment } from '../env.js';
import type { AppEnvironment } from '../types.js';
import { ApiError } from './errors.js';
import { writeLog } from './logger.js';

/**
 * Stable reasons for a rejected bearer token. They are logged and returned in
 * `WWW-Authenticate` so an operator can diagnose issuer/audience drift without
 * ever logging the token or its claims.
 */
export type BearerRejectionReason =
  | 'malformed'
  | 'bad_issuer'
  | 'bad_audience'
  | 'expired'
  | 'bad_signature'
  | 'jwks_fetch_failed'
  | 'invalid_claims'
  | 'email_unverified'
  | 'invalid_token_use';

export interface VerifiedIdentity {
  id: string;
  email: string;
  verified: boolean;
  sessionId: string;
  stepUpAt: number;
  webProxy: boolean;
}

const WEB_PROXY_TOKEN_USE = 'pressay_web_proxy';
const INTERNAL_PROXY_AUDIENCE = 'pressay-api';
const AUTH_REALM = 'pressay-api';

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function remoteKeySet(url: string) {
  const existing = remoteKeySets.get(url);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(url), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
  });
  remoteKeySets.set(url, created);
  return created;
}

export function clearRemoteKeySetsForTests(): void {
  remoteKeySets.clear();
}

class BearerRejected extends Error {
  public constructor(public readonly reason: BearerRejectionReason) {
    super(reason);
    this.name = 'BearerRejected';
  }
}

/** Map a jose (or JWKS transport) failure to a stable rejection reason. */
export function classifyJwtError(error: unknown): BearerRejectionReason {
  if (error instanceof BearerRejected) return error.reason;
  if (error instanceof joseErrors.JWTExpired) return 'expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === 'aud') return 'bad_audience';
    if (error.claim === 'iss') return 'bad_issuer';
    return 'invalid_claims';
  }
  if (
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys
  ) {
    return 'bad_signature';
  }
  if (
    error instanceof joseErrors.JWKSTimeout ||
    error instanceof joseErrors.JWKSInvalid
  ) {
    return 'jwks_fetch_failed';
  }
  if (
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JOSEAlgNotAllowed ||
    error instanceof joseErrors.JOSENotSupported
  ) {
    return 'malformed';
  }
  // A generic JOSEError (non-200 JWKS response) or a transport error from fetch.
  return 'jwks_fetch_failed';
}

function issuerVariants(issuer: string): string[] {
  const trimmed = issuer.replace(/\/+$/, '');
  return [...new Set([issuer, trimmed, `${trimmed}/`])];
}

function audienceList(payload: JWTPayload): string[] {
  if (Array.isArray(payload.aud)) return payload.aud;
  return typeof payload.aud === 'string' ? [payload.aud] : [];
}

function identityFromPayload(payload: JWTPayload, webProxy: boolean): VerifiedIdentity {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new BearerRejected('invalid_claims');
  }
  if (typeof payload.email !== 'string') throw new BearerRejected('invalid_claims');
  if (payload.email_verified !== true) throw new BearerRejected('email_unverified');
  return {
    id: payload.sub,
    email: payload.email,
    verified: true,
    webProxy,
    sessionId: typeof payload.sid === 'string' ? payload.sid : '',
    stepUpAt:
      webProxy &&
      ['totp', 'backup_code'].includes(String(payload.pressay_step_up_method)) &&
      typeof payload.pressay_step_up_at === 'number'
        ? payload.pressay_step_up_at
        : 0,
  };
}

/**
 * Verify a bearer token issued by the single Pressay identity provider (the web
 * app's Better Auth OAuth 2.1 server) or by the web server-side proxy.
 *
 * Audience separation: Mac OAuth access tokens carry the API audience and never
 * a `token_use` claim. Web proxy tokens carry the dedicated proxy audience and
 * `token_use=pressay_web_proxy`; only they may present step-up proof. During
 * the web rollout, proxy tokens minted with the API audience are still accepted
 * while `PRESSAY_WEB_PROXY_LEGACY_AUDIENCE_ALLOWED=true`.
 */
export async function verifyBearerToken(token: string): Promise<VerifiedIdentity> {
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(token);
  } catch {
    throw new BearerRejected('malformed');
  }
  const environment = getEnvironment();
  const issuer = unverified.iss;
  const betterAuthIssuer = environment.PRESSAY_BETTER_AUTH_JWT_ISSUER;
  const betterAuthJwksUrl = environment.PRESSAY_BETTER_AUTH_JWKS_URL;

  if (
    issuer === environment.PRESSAY_INTERNAL_JWT_ISSUER &&
    environment.PRESSAY_INTERNAL_JWT_SECRET
  ) {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(environment.PRESSAY_INTERNAL_JWT_SECRET),
      {
        algorithms: ['HS256'],
        issuer: environment.PRESSAY_INTERNAL_JWT_ISSUER,
        audience: INTERNAL_PROXY_AUDIENCE,
        maxTokenAge: '5m',
      },
    );
    if (payload.token_use !== WEB_PROXY_TOKEN_USE) {
      throw new BearerRejected('invalid_token_use');
    }
    return identityFromPayload(payload, true);
  }

  if (
    betterAuthIssuer &&
    betterAuthJwksUrl &&
    typeof issuer === 'string' &&
    issuerVariants(betterAuthIssuer).includes(issuer)
  ) {
    const apiAudiences = environment.PRESSAY_BETTER_AUTH_JWT_AUDIENCE.split(',')
      .map((audience) => audience.trim())
      .filter(Boolean);
    const proxyAudience = environment.PRESSAY_WEB_PROXY_JWT_AUDIENCE;
    const { payload } = await jwtVerify(token, remoteKeySet(betterAuthJwksUrl), {
      algorithms: ['EdDSA', 'ES256', 'ES512', 'RS256', 'PS256'],
      issuer: issuerVariants(betterAuthIssuer),
      audience: [...apiAudiences, proxyAudience],
    });
    const audiences = audienceList(payload);
    const tokenUse = payload.token_use;
    if (audiences.includes(proxyAudience)) {
      if (tokenUse !== WEB_PROXY_TOKEN_USE)
        throw new BearerRejected('invalid_token_use');
      return identityFromPayload(payload, true);
    }
    if (tokenUse === undefined) return identityFromPayload(payload, false);
    if (
      tokenUse === WEB_PROXY_TOKEN_USE &&
      environment.PRESSAY_WEB_PROXY_LEGACY_AUDIENCE_ALLOWED
    ) {
      return identityFromPayload(payload, true);
    }
    throw new BearerRejected('invalid_token_use');
  }

  throw new BearerRejected('bad_issuer');
}

function unauthorized(reason?: BearerRejectionReason): ApiError {
  const challenge = reason
    ? `Bearer realm="${AUTH_REALM}", error="invalid_token", error_description="${reason}"`
    : `Bearer realm="${AUTH_REALM}"`;
  return new ApiError(401, 'unauthorized', 'Authentication required', {
    'WWW-Authenticate': challenge,
  });
}

export const requireAuthentication = createMiddleware<AppEnvironment>(
  async (context, next) => {
    const authorization = context.req.header('Authorization');
    if (!authorization) throw unauthorized();

    const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(authorization);
    let identity: VerifiedIdentity;
    try {
      if (!match?.[1]) throw new BearerRejected('malformed');
      identity = await verifyBearerToken(match[1]);
    } catch (error) {
      const reason = classifyJwtError(error);
      writeLog('warn', 'auth.bearer_rejected', {
        reason,
        error_name: error instanceof Error ? error.name : typeof error,
        method: context.req.method,
        request_id: context.get('requestId'),
      });
      throw unauthorized(reason);
    }

    context.set('authUserId', identity.id);
    context.set('authEmail', identity.email);
    context.set('authEmailVerified', identity.verified);
    context.set('authStepUpAt', identity.stepUpAt);
    context.set('authSessionId', identity.sessionId);
    context.set('authWebProxy', identity.webProxy);
    await next();
  },
);
