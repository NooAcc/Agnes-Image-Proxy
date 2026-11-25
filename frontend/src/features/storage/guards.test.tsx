import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { adminHandlers, createAdminState } from "@/test/handlers";
import { renderApp } from "@/test/render";
import { errorResponse, startServer, type MockServer } from "@/test/server";

let server: MockServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
  window.localStorage.clear();
});

describe("storage guards", () => {
  it("redirects before mounting the console shell", async () => {
    const state = createAdminState({ storage: { initialized: false } });
    server = startServer(adminHandlers(state));
    const { router } = renderApp(["/gallery"]);

    expect(await screen.findByRole("heading", { name: "初始化 Agnes Image Proxy" })).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    expect(screen.queryByRole("navigation", { name: "主导航" })).not.toBeInTheDocument();
  });

  it("retries a failed storage status without falling back to setup", async () => {
    const state = createAdminState();
    let failed = false;
    server = startServer([
      (request) => {
        if (request.path === "/admin/api/storage" && request.method === "GET" && !failed) {
          failed = true;
          return errorResponse(500, "storage status unavailable");
        }
        return undefined;
      },
      ...adminHandlers(state),
    ]);
    renderApp(["/accounts"]);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("加载失败");
    expect(screen.queryByRole("heading", { name: "初始化 Agnes Image Proxy" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("heading", { name: "上游账号" })).toBeInTheDocument();
  });

  it("refetches status after initialization conflict", async () => {
    const state = createAdminState({ storage: { initialized: false } });
    let posts = 0;
    server = startServer([
      (request) => {
        if (request.path === "/admin/api/storage" && request.method === "POST") {
          posts += 1;
          if (posts === 1) {
            state.storage = {
              initialized: true,
              mode: "imgbed",
              imgbedBaseUrl: "https://img.example.com",
              hasImgbedToken: true,
            };
            return errorResponse(409, "storage is already initialized", null, "already_initialized");
          }
        }
        return undefined;
      },
      ...adminHandlers(state),
    ]);
    const { router } = renderApp(["/setup"]);

    await screen.findByRole("heading", { name: "初始化 Agnes Image Proxy" });
    await userEvent.click(screen.getByRole("radio", { name: /本地存储/ }));
    await userEvent.click(screen.getByRole("button", { name: "完成初始化" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/overview"));
    expect(screen.queryByRole("heading", { name: "初始化 Agnes Image Proxy" })).not.toBeInTheDocument();
  });
});
