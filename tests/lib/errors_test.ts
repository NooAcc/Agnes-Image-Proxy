import { assertEquals } from "@std/assert";
import { ApiError, errorResponseBody } from "../../lib/errors.ts";

Deno.test("ApiError renders the OpenAI nested envelope", () => {
  const body = errorResponseBody(
    new ApiError(400, "bad mask", "invalid_request_error", "mask", "unsupported_parameter"),
  );
  assertEquals(body, {
    error: {
      message: "bad mask",
      type: "invalid_request_error",
      param: "mask",
      code: "unsupported_parameter",
    },
  });
});

Deno.test("ApiError defaults to a server_error envelope", () => {
  const body = errorResponseBody(new ApiError(500, "boom"));
  assertEquals(body, {
    error: { message: "boom", type: "server_error", param: null, code: null },
  });
});
