import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import {
  billingRedirectSchema,
  checkoutRequestSchema,
  restoreAppStoreRequestSchema,
  restoreAppStoreResponseSchema,
} from '../contracts/billing.js';
import { requireAuthentication } from '../lib/auth-middleware.js';
import { ApiError } from '../lib/errors.js';
import { writeLog } from '../lib/logger.js';
import { rateLimit } from '../lib/rate-limit.js';
import {
  createBillingPortal,
  createCheckout,
  getBillingStatus,
  processStripeWebhook,
} from '../services/billing.js';
import {
  processAppleWebhook,
  restoreAppStorePurchase,
} from '../services/apple-billing.js';
import type { AppEnvironment } from '../types.js';

export const billingRoutes = new Hono<AppEnvironment>();

billingRoutes.use('/billing/*', requireAuthentication);

billingRoutes.post(
  '/billing/checkout',
  rateLimit('billing_checkout', 10),
  zValidator('json', checkoutRequestSchema, (result) => {
    if (!result.success)
      throw new ApiError(422, 'invalid_request', 'Invalid billing request');
  }),
  async (context) => {
    const idempotencyKey = context.req.header('idempotency-key');
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 255) {
      throw new ApiError(
        422,
        'idempotency_key_required',
        'A valid idempotency key is required',
      );
    }
    return context.json(
      billingRedirectSchema.parse({
        url: await createCheckout(
          context.get('authUserId'),
          context.get('authEmail'),
          context.req.valid('json').interval,
          idempotencyKey,
          context.req.valid('json').termsVersion,
          context.req.valid('json').immediatePerformanceConsent,
        ),
      }),
      201,
    );
  },
);

billingRoutes.post(
  '/billing/portal',
  rateLimit('billing_portal', 10),
  async (context) => {
    return context.json(
      billingRedirectSchema.parse({
        url: await createBillingPortal(context.get('authUserId')),
      }),
      201,
    );
  },
);

billingRoutes.get('/billing/status', async (context) => {
  return context.json(await getBillingStatus(context.get('authUserId')));
});

billingRoutes.post(
  '/billing/restore-app-store',
  rateLimit('apple_restore', 10),
  zValidator('json', restoreAppStoreRequestSchema, (result) => {
    if (!result.success) {
      throw new ApiError(422, 'invalid_request', 'Invalid App Store restore request');
    }
  }),
  async (context) => {
    const idempotencyKey = context.req.header('idempotency-key');
    if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 255) {
      throw new ApiError(
        422,
        'idempotency_key_required',
        'A valid idempotency key is required',
      );
    }
    const body = context.req.valid('json');
    return context.json(
      restoreAppStoreResponseSchema.parse(
        await restoreAppStorePurchase(
          context.get('authUserId'),
          body.signedTransaction,
          idempotencyKey,
          { linkToCurrentAccount: body.linkToCurrentAccount === true },
        ),
      ),
    );
  },
);

billingRoutes.post('/webhooks/stripe', async (context) => {
  const declaredLength = Number(context.req.header('content-length') ?? '0');
  if (declaredLength > 1_048_576) {
    throw new ApiError(422, 'webhook_too_large', 'Webhook payload is too large');
  }
  const signature = context.req.header('stripe-signature');
  if (!signature)
    throw new ApiError(401, 'stripe_signature_required', 'Stripe signature required');
  const rawBody = await context.req.raw.text();
  if (Buffer.byteLength(rawBody, 'utf8') > 1_048_576) {
    throw new ApiError(422, 'webhook_too_large', 'Webhook payload is too large');
  }
  const result = await processStripeWebhook(rawBody, signature);
  writeLog('info', 'billing.webhook.completed', {
    outcome: result.duplicateOrIgnored ? 'ignored' : 'applied',
    provider: 'stripe',
  });
  return context.json({ received: true });
});

billingRoutes.post('/webhooks/apple', async (context) => {
  const declaredLength = Number(context.req.header('content-length') ?? '0');
  if (declaredLength > 1_048_576) {
    throw new ApiError(422, 'webhook_too_large', 'Webhook payload is too large');
  }
  const rawBody = await context.req.raw.text();
  if (Buffer.byteLength(rawBody, 'utf8') > 1_048_576) {
    throw new ApiError(422, 'webhook_too_large', 'Webhook payload is too large');
  }
  const result = await processAppleWebhook(rawBody);
  const status = result.duplicateOrIgnored ? 'ignored' : 'applied';
  writeLog('info', 'billing.webhook.completed', {
    outcome: status,
    provider: 'apple',
    ...(result.code ? { code: result.code } : {}),
  });
  // Always 200 for a verified notification: Apple retries non-2xx responses for
  // days, and an event we cannot attach (for example no appAccountToken) will
  // never become attachable by retrying. It is recorded as `ignored` instead.
  return context.json({
    received: true,
    status,
    ...(result.code ? { code: result.code } : {}),
  });
});
