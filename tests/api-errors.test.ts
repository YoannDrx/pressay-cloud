import Stripe from 'stripe';
import { expect, it } from 'vitest';
import { ApiError, publicApiError } from '../src/lib/errors.js';

it('reports restricted Stripe permissions without forwarding provider details', () => {
  const error = new Stripe.errors.StripePermissionError({
    message: 'Private provider diagnostics and customer information',
    code: 'more_permissions_required',
  });
  const result = publicApiError(error);
  expect(result?.status).toBe(503);
  expect(result?.code).toBe('stripe_permissions_required');
  expect(result?.message).not.toContain('Private');
  expect(publicApiError(new Error('Private'))).toBeUndefined();
});

it('preserves intentional API errors', () => {
  const error = new ApiError(403, 'admin_required', 'Administrator required');
  expect(publicApiError(error)).toBe(error);
});
