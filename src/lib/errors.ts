export class ApiError extends Error {
  public constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Never forward provider messages: they may contain credentials or customer data. */
export function publicApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (
    error instanceof Error &&
    'type' in error &&
    error.type === 'StripePermissionError'
  ) {
    return new ApiError(
      503,
      'stripe_permissions_required',
      'Stripe server permissions require administrator attention',
    );
  }
  return undefined;
}
