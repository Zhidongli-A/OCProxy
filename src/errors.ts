/**
 * HTTP error raised by adapters, routing, and model validation.
 * The active downstream adapter renders it in the client's native envelope.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;

  constructor(
    status: number,
    message: string,
    code = "invalid_request_error",
    type = "invalid_request_error",
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export function badRequest(message: string, code = "invalid_request_error"): HttpError {
  return new HttpError(400, message, code, "invalid_request_error");
}

export function modelNotFound(message: string): HttpError {
  return new HttpError(404, message, "model_not_found", "invalid_request_error");
}
