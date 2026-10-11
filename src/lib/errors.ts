export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503;

export class ApiError extends Error {
  public constructor(
    public readonly status: ApiErrorStatus,
    public readonly code: string,
    message: string,
    /** Extra response headers, such as `WWW-Authenticate`. Never put secrets here. */
    public readonly headers: Readonly<Record<string, string>> = {},
    /** Extra public, non-sensitive fields merged into the error envelope. */
    public readonly details: Readonly<Record<string, string | boolean>> = {},
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

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

/**
 * Map any thrown value to a stable, non-sensitive code suitable for logs and
 * persisted failure records. Messages are never used: provider and database
 * messages may contain customer data or credentials.
 */
export function stableErrorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (typeof error !== 'object' || error === null) return 'internal_error';
  if (
    'type' in error &&
    typeof error.type === 'string' &&
    error.type.startsWith('Stripe')
  ) {
    return `stripe_${snakeCase(error.type.slice('Stripe'.length)) || 'error'}`;
  }
  if (
    'code' in error &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code)
  ) {
    // PostgreSQL SQLSTATE, for example 40001 or 23505.
    return `database_${error.code.toLowerCase()}`;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout';
    if (error.name === 'ZodError') return 'invalid_internal_data';
  }
  return 'internal_error';
}

/** Error class names along the `cause` chain, outermost first. Names only. */
export function errorCauseChain(error: unknown, maxDepth = 5): string {
  const names: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      names.push(/^[A-Za-z0-9_]{1,64}$/.test(current.name) ? current.name : 'Error');
      current = current.cause;
    } else {
      names.push(current === null ? 'null' : typeof current);
      break;
    }
  }
  return names.join('>');
}
