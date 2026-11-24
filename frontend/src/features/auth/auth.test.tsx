import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { adminHandlers, createAdminState } from "@/test/handlers";
import { renderApp } from "@/test/render";
import { startServer, errorResponse, type MockServer } from "@/test/server";
import { api } from "@/lib/api";
import { blobCache } from "@/lib/blob-cache";

let server: MockServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
  window.localStorage.clear();
});

describe("login", () => {
  it("navigates to the console after a successful login and stores nothing", async () => {
    const state = createAdminState({ authenticated: false });
    server = startServer(adminHandlers(state));
    const { router } = renderApp(["/login"]);

    const input = await screen.findByLabelText("管理密钥");
    await userEvent.type(input, "secret-key");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/overview"));
    expect(state.authenticated).toBe(true);
    expect(window.localStorage.length).toBe(0);
    expect(
      server.calls.some((call) =>
        (JSON.stringify(call.body ?? null) ?? "").includes("secret-key"),
      ),
    ).toBe(true);
  });

  it("ignores a pre-login session 401 that arrives after successful login", async () => {
    const state = createAdminState({ authenticated: false });
    let resolveOld!: (response: Response) => void;
    let first = true;
    server = startServer([(request) => {
      if (request.path === "/admin/api/session" && request.method === "GET" && first) {
        first = false;
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      }
      return undefined;
    }, ...adminHandlers(state)]);
    const { router } = renderApp(["/login"]);
    await userEvent.type(await screen.findByLabelText("管理密钥"), "secret-key");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/overview"));
    resolveOld(errorResponse(401, "old session expired"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(router.state.location.pathname).toBe("/overview");
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
  });

  it("shows an error for a rejected key", async () => {
    const state = createAdminState({ authenticated: false });
    server = startServer(adminHandlers(state));
    renderApp(["/login"]);

    const input = await screen.findByLabelText("管理密钥");
    await userEvent.type(input, "wrong-key");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid API key");
  });
});

describe("session guard", () => {
  it.each(["json", "blob", "session"])("expires protected UI and cached data after %s 401", async (kind) => {
    const state = createAdminState();
    let expired = false;
    server = startServer([(request) => expired && request.path.startsWith("/admin/api/") ? errorResponse(401, "expired") : undefined, ...adminHandlers(state)]);
    const { router, queryClient } = renderApp(["/accounts"]);
    await screen.findByRole("heading", { name: "上游账号" });
    queryClient.setQueryData(["sensitive"], { prompt: "previous session" });
    expired = true;
    try {
      if (kind === "blob") await blobCache.load(987, "image");
      else await api(kind === "session" ? "/admin/api/session" : "/admin/api/logs");
    } catch { /* Expected unauthorized response. */ }
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(queryClient.getQueryData(["sensitive"])).toBeUndefined();
    expect(screen.queryByRole("heading", { name: "上游账号" })).not.toBeInTheDocument();
  });

  it("redirects unauthenticated visits to the login page", async () => {
    const state = createAdminState({ authenticated: false });
    server = startServer(adminHandlers(state));
    const { router } = renderApp(["/accounts"]);

    expect(await screen.findByRole("heading", { name: "登录" })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });
});
