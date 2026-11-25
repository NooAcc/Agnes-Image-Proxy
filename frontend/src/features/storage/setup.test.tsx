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

describe("first-run setup", () => {
  it("requires an explicit mode and shows the local description", async () => {
    const state = createAdminState({ storage: { initialized: false } });
    server = startServer(adminHandlers(state));
    const { router } = renderApp(["/gallery"]);

    expect(await screen.findByRole("heading", { name: "初始化 Agnes Image Proxy" })).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    expect(screen.getByRole("button", { name: "完成初始化" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /本地存储/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /图床存储/ })).not.toBeChecked();
    expect(screen.queryByLabelText("API Token")).not.toBeInTheDocument();
  });

  it("initializes local storage and enters the console", async () => {
    const state = createAdminState({ storage: { initialized: false } });
    server = startServer(adminHandlers(state));
    const { router } = renderApp(["/setup"]);

    await screen.findByRole("heading", { name: "初始化 Agnes Image Proxy" });
    await userEvent.click(screen.getByRole("radio", { name: /本地存储/ }));
    const button = screen.getByRole("button", { name: "完成初始化" });
    expect(button).toBeEnabled();
    await userEvent.click(button);

    await waitFor(() => expect(router.state.location.pathname).toBe("/overview"));
    expect(state.storage).toEqual({ initialized: true, mode: "local" });
    const post = server.calls.find((call) => call.method === "POST" && call.path === "/admin/api/storage");
    expect(post?.body).toEqual({ mode: "local" });
  });

  it("requires address and token for imgbed and sends only contract fields", async () => {
    const state = createAdminState({ storage: { initialized: false } });
    server = startServer(adminHandlers(state));
    const { router } = renderApp(["/setup"]);
    await screen.findByRole("heading", { name: "初始化 Agnes Image Proxy" });

    await userEvent.click(screen.getByRole("radio", { name: /图床存储/ }));
    const button = screen.getByRole("button", { name: "完成初始化" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("图床站点地址"), "https://img.example.com");
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("API Token"), "secret-token");
    expect(button).toBeEnabled();
    await userEvent.click(button);

    await waitFor(() => expect(router.state.location.pathname).toBe("/overview"));
    const post = server.calls.find((call) => call.method === "POST" && call.path === "/admin/api/storage");
    expect(post?.body).toEqual({
      mode: "imgbed",
      imgbedBaseUrl: "https://img.example.com",
      imgbedToken: "secret-token",
    });
    expect(window.localStorage.length).toBe(0);
    expect(state.storage).toMatchObject({ mode: "imgbed", hasImgbedToken: true });
  });

  it("keeps the draft and shows the server error after a rejected submit", async () => {
    const state = createAdminState({ storage: { initialized: false } });
    server = startServer([
      (request) => {
        if (request.path === "/admin/api/storage" && request.method === "POST") {
          return errorResponse(400, "imgbedBaseUrl must use https", "imgbedBaseUrl", "invalid_value");
        }
        return undefined;
      },
      ...adminHandlers(state),
    ]);
    const { router } = renderApp(["/setup"]);
    await screen.findByRole("heading", { name: "初始化 Agnes Image Proxy" });
    await userEvent.click(screen.getByRole("radio", { name: /图床存储/ }));
    await userEvent.type(screen.getByLabelText("图床站点地址"), "http://img.example.com");
    await userEvent.type(screen.getByLabelText("API Token"), "tok");
    await userEvent.click(screen.getByRole("button", { name: "完成初始化" }));

    expect((await screen.findAllByText(/must use https/)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("图床站点地址")).toHaveValue("http://img.example.com");
    expect(screen.getByLabelText("API Token")).toHaveValue("tok");
    expect(router.state.location.pathname).toBe("/setup");
  });
});
