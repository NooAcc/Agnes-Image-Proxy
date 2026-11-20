export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/** Error carrying an HTTP status and an OpenAI-shaped payload. */
export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly param: string | null;
  readonly code: string | null;
  readonly headers: Headers;

  constructor(
    status: number,
    message: string,
    type: string = "server_error",
    param: string | null = null,
    code: string | null = null,
    headers?: HeadersInit,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.param = param;
    this.code = code;
    this.headers = new Headers(headers);
  }
}

export function errorResponseBody(error: ApiError): OpenAIErrorBody {
  return {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code,
    },
  };
}
