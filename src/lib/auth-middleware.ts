import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';

import { getAuth } from '../auth.js';
import { getEnvironment } from '../env.js';
import type { AppEnvironment } from '../types.js';
import { ApiError } from './errors.js';

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function remoteKeySet(url: string) {
  const existing = remoteKeySets.get(url);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(url));
  remoteKeySets.set(url, created);
  return created;
}

async function verifyExternalBearer(authorization: string | undefined) {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  const environment = getEnvironment();
  const issuer = decodeJwt(token).iss;
  const betterAuthIssuer = environment.PRESSAY_BETTER_AUTH_JWT_ISSUER;
  const betterAuthJwksUrl = environment.PRESSAY_BETTER_AUTH_JWKS_URL;
  let verified;

  if (
    issuer === environment.PRESSAY_INTERNAL_JWT_ISSUER &&
    environment.PRESSAY_INTERNAL_JWT_SECRET
  ) {
    verified = await jwtVerify(
      token,
      new TextEncoder().encode(environment.PRESSAY_INTERNAL_JWT_SECRET),
      {
        algorithms: ['HS256'],
        issuer: environment.PRESSAY_INTERNAL_JWT_ISSUER,
        audience: 'pressay-api',
        maxTokenAge: '5m',
      },
    );
    if (verified.payload.token_use !== 'pressay_web_proxy') return null;
  } else if (issuer === betterAuthIssuer && betterAuthIssuer && betterAuthJwksUrl) {
    verified = await jwtVerify(token, remoteKeySet(betterAuthJwksUrl), {
      algorithms: ['EdDSA', 'ES256', 'ES512', 'RS256', 'PS256'],
      issuer: betterAuthIssuer,
      audience: environment.PRESSAY_BETTER_AUTH_JWT_AUDIENCE.split(',')
        .map((audience) => audience.trim())
        .filter(Boolean),
    });
  } else {
    return null;
  }

  const { payload } = verified;
  if (
    !payload.sub ||
    payload.email_verified !== true ||
    typeof payload.email !== 'string'
  ) {
    return null;
  }
  return {
    id: payload.sub,
    email: payload.email,
    verified: true,
    webProxy: payload.token_use === 'pressay_web_proxy',
    sessionId: typeof payload.sid === 'string' ? payload.sid : '',
    stepUpAt:
      payload.token_use === 'pressay_web_proxy' &&
      ['totp', 'backup_code'].includes(String(payload.pressay_step_up_method)) &&
      typeof payload.pressay_step_up_at === 'number'
        ? payload.pressay_step_up_at
        : 0,
  };
}

export const requireAuthentication = createMiddleware<AppEnvironment>(
  async (context, next) => {
    const authSession = await getAuth().api.getSession({
      headers: context.req.raw.headers,
    });
    let identity: {
      id: string;
      email: string;
      verified: boolean;
      sessionId: string;
      stepUpAt: number;
      webProxy: boolean;
    } | null = authSession
      ? {
          id: authSession.user.id,
          email: authSession.user.email,
          verified: authSession.user.emailVerified,
          sessionId: authSession.session.id,
          stepUpAt: 0,
          webProxy: false,
        }
      : null;
    if (!identity) {
      try {
        identity = await verifyExternalBearer(context.req.header('Authorization'));
      } catch {
        identity = null;
      }
    }
    if (!identity) {
      throw new ApiError(401, 'unauthorized', 'Authentication required');
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
