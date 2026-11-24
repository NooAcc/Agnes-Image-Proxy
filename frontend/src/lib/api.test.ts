import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setUnauthorizedHandler } from "@/lib/api";
import { startServer, errorResponse, type MockServer } from "@/test/server";

let server: MockServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
  setUnauthorizedHandler(null);
});

describe("api", () => {
  it("clears authentication via the registered handler on a 401", async () => {
    server = startServer([() => errorResponse(401, "session is invalid")]);
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(api("/admin/api/accounts")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not treat a rejected login as an expired session", async () => {
    server = startServer([() => errorResponse(401, "invalid API key")]);
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(
      api("/admin/api/session", { method: "POST", body: JSON.stringify({ apiKey: "bad" }) }),
    ).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });
});
