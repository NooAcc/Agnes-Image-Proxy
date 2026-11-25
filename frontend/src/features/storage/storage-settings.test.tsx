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

const imgbed = {
  initialized: true as const,
  mode: "imgbed" as const,
  imgbedBaseUrl: "https://img.example.com",
  hasImgbedToken: true,
};

describe("storage settings", () => {
  it("keeps the fixed mode read only and never renders the token", async () => {
    const state = createAdminState({ storage: imgbed });
    server = startServer(adminHandlers(state));
    renderApp(["/settings"]);

    expect(await screen.findByText("图床存储")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /存储方式/ })).not.toBeInTheDocument();
    expect(screen.getByText(/已配置/)).toBeInTheDocument();
    const token = screen.getByLabelText("更新 API Token");
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("type", "password");
  });

  it("omits an empty replacement token", async () => {
    const state = createAdminState({ storage: imgbed });
    server = startServer(adminHandlers(state));
    renderApp(["/settings"]);

    const save = await screen.findByRole("button", { name: "保存原图存储" });
    await userEvent.click(save);
    await waitFor(() => {
      const put = server?.calls.find((call) => call.method === "PUT" && call.path === "/admin/api/storage");
      expect(put?.body).toEqual({ imgbedBaseUrl: "https://img.example.com" });
    });
  });

  it("updates address and token without caching the secret", async () => {
    const state = createAdminState({ storage: imgbed });
    server = startServer(adminHandlers(state));
    renderApp(["/settings"]);

    const base = await screen.findByLabelText("图床站点地址");
    await userEvent.clear(base);
    await userEvent.type(base, "https://new.example.com");
    await userEvent.type(screen.getByLabelText("更新 API Token"), "replacement-token");
    await userEvent.click(screen.getByRole("button", { name: "保存原图存储" }));

    expect(await screen.findByRole("status")).toHaveTextContent("原图存储设置已保存");
    const put = server.calls.find((call) => call.method === "PUT" && call.path === "/admin/api/storage");
    expect(put?.body).toEqual({ imgbedBaseUrl: "https://new.example.com", imgbedToken: "replacement-token" });
    expect(screen.getByLabelText("更新 API Token")).toHaveValue("");
    expect(window.localStorage.length).toBe(0);
  });

  it("preserves the draft when the update is rejected", async () => {
    const state = createAdminState({ storage: imgbed });
    server = startServer([
      (request) => {
        if (request.path === "/admin/api/storage" && request.method === "PUT") {
          return errorResponse(400, "imgbedBaseUrl is invalid", "imgbedBaseUrl", "invalid_value");
        }
        return undefined;
      },
      ...adminHandlers(state),
    ]);
    renderApp(["/settings"]);

    const base = await screen.findByLabelText("图床站点地址");
    await userEvent.clear(base);
    await userEvent.type(base, "http://bad.example.com");
    await userEvent.click(screen.getByRole("button", { name: "保存原图存储" }));

    expect((await screen.findAllByText("imgbedBaseUrl is invalid")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("图床站点地址")).toHaveValue("http://bad.example.com");
  });

  it("shows local mode without any imgbed controls", async () => {
    const state = createAdminState({ storage: { initialized: true, mode: "local" } });
    server = startServer(adminHandlers(state));
    renderApp(["/settings"]);

    expect(await screen.findByText("本地存储")).toBeInTheDocument();
    expect(screen.queryByLabelText("更新 API Token")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("图床站点地址")).not.toBeInTheDocument();
  });
});
