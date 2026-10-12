import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';
import { z } from 'zod';

import { getEnvironment } from '../env.js';

export const WEB_INTERNAL_AUDIENCE = 'pressay-web-internal';
const REQUEST_TIMEOUT_MS = 8_000;
const TOKEN_LIFETIME_SECONDS = 300;

/** A failure that the deletion job records (code only) and retries. */
export class WebIdentityDeletionError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'WebIdentityDeletionError';
  }
}

export type WebIdentityDeletionResult = 'deleted' | 'absent' | 'skipped';

const responseSchema = z.object({ deleted: z.boolean() });

function webInternalOrigin(): string | undefined {
  const environment = getEnvironment();
  if (environment.PRESSAY_WEB_INTERNAL_ORIGIN) {
    return new URL(environment.PRESSAY_WEB_INTERNAL_ORIGIN).origin;
  }
  if (environment.PRESSAY_BETTER_AUTH_JWT_ISSUER) {
    return new URL(environment.PRESSAY_BETTER_AUTH_JWT_ISSUER).origin;
  }
  return undefined;
}

/**
 * Ask the web identity provider to delete the Better Auth user whose subject
 * owns this Cloud account. The call is idempotent: `{deleted:false}` means the
 * identity no longer exists and counts as success. Any other outcome throws a
 * WebIdentityDeletionError so the deletion job retries with backoff.
 */
export async function deleteWebIdentity(
  subject: string,
  now = Math.floor(Date.now() / 1000),
): Promise<WebIdentityDeletionResult> {
  const environment = getEnvironment();
  const origin = webInternalOrigin();
  const secret = environment.PRESSAY_INTERNAL_JWT_SECRET;
  if (!origin || !secret) {
    // Local development has no web identity provider to clean up.
    if (environment.PRESSAY_DEPLOYMENT_ENV === 'development') return 'skipped';
    throw new WebIdentityDeletionError('web_identity_deletion_not_configured');
  }

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(environment.PRESSAY_CLOUD_INTERNAL_JWT_ISSUER)
    .setAudience(WEB_INTERNAL_AUDIENCE)
    .setSubject(subject)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
    .sign(new TextEncoder().encode(secret));

  let response: Response;
  try {
    response = await fetch(new URL('/api/internal/identity-deletion', origin), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ userId: subject, reason: 'account_deleted' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new WebIdentityDeletionError('web_identity_unreachable');
  }

  if (response.status === 200) {
    const parsed = responseSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!parsed.success)
      throw new WebIdentityDeletionError('web_identity_bad_response');
    return parsed.data.deleted ? 'deleted' : 'absent';
  }
  // Drain the body without reading it into logs.
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw new WebIdentityDeletionError('web_identity_unauthorized');
  }
  if (response.status === 400 || response.status === 422) {
    throw new WebIdentityDeletionError('web_identity_bad_request');
  }
  if (response.status >= 500) {
    throw new WebIdentityDeletionError('web_identity_unavailable');
  }
  throw new WebIdentityDeletionError('web_identity_unexpected_status');
}
