/**
 * One error shape for the whole platform. Handlers throw ApiError; the global
 * error hook turns it into the documented { data, error } envelope.
 */
export const ErrorCodes = {
  AUTH_REQUIRED: 401,
  INVALID_TOKEN: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  TABLE_NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  /**
   * 413, not 429. A rate limit says "slower"; a quota says "this project
   * cannot hold any more of this". Retrying the same request will never
   * succeed, and telling a client 429 invites it to back off and try again
   * forever.
   */
  QUOTA_EXCEEDED: 413,
  DATABASE_ERROR: 400,
  STORAGE_ERROR: 400,
  PROVISIONING_ERROR: 500,
  INTERNAL_ERROR: 500,
  /**
   * The server agent could not be reached. 503, not 500: the API is fine and
   * the request is fine — the privileged half is simply not running, and
   * retrying after starting it will work. The distinction matters because the
   * dashboard tells the operator to start the agent rather than opening a bug.
   */
  AGENT_UNAVAILABLE: 503,
  /** The agent was reached and refused or failed the operation. */
  AGENT_OPERATION_FAILED: 502,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ErrorCodes[code];
    this.details = details;
  }
}

export const notFound = (what: string) => new ApiError('NOT_FOUND', `${what} not found`);
export const forbidden = (why = 'You do not have access to this resource') =>
  new ApiError('FORBIDDEN', why);
