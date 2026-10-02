export const ErrorCodes = {
  INVALID_PARAMETER: { status: 400, message: 'One or more query parameters are invalid.' },
  INVALID_URL: { status: 400, message: 'The source URL is invalid.' },
  INVALID_API_KEY: { status: 401, message: 'The API key is missing or not recognised.' },
  INVALID_SIGNATURE: { status: 403, message: 'The request signature is missing or invalid.' },
  FORBIDDEN_URL: { status: 403, message: 'The source URL points to a host that is not allowed.' },
  NOT_FOUND: { status: 404, message: 'Route not found.' },
  SOURCE_NOT_FOUND: { status: 404, message: 'The source asset could not be found.' },
  SOURCE_TOO_LARGE: { status: 413, message: 'The source asset exceeds the maximum allowed size.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'The source asset is not a supported media type.' },
  UNPROCESSABLE_SOURCE: { status: 422, message: 'The source asset could not be decoded.' },
  RATE_LIMITED: { status: 429, message: 'Rate limit exceeded. Retry after the delay in the Retry-After header.' },
  SOURCE_FETCH_FAILED: { status: 502, message: 'Failed to fetch the source asset.' },
  SOURCE_TIMEOUT: { status: 504, message: 'Timed out while fetching the source asset.' },
  INTERNAL_ERROR: { status: 500, message: 'An unexpected error occurred.' },
  SERVER_BUSY: { status: 503, message: 'The server is at capacity. Retry after the delay in the Retry-After header.' },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export interface ErrorDetail {
  field?: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];

  constructor(code: ErrorCode, message?: string, details?: ErrorDetail[]) {
    super(message ?? ErrorCodes[code].message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ErrorCodes[code].status;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details?.length ? { details: this.details } : {}),
      },
    };
  }
}
