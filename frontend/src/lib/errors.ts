import { ApiError } from "./api";

// errorMessage renders any thrown value for humans without leaking internals.
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "请求失败，请稍后重试";
}

export interface FieldError {
  field: string | null;
  message: string;
}

// fieldErrors collects the API's param pointer into a single field error.
export function fieldErrors(error: unknown): FieldError[] {
  if (error instanceof ApiError) {
    return [{ field: error.param, message: error.message }];
  }
  if (error) {
    return [{ field: null, message: errorMessage(error) }];
  }
  return [];
}

export function fieldErrorFor(error: unknown, field: string): string | undefined {
  return fieldErrors(error).find((issue) => issue.field === field)?.message;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
