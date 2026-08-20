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
