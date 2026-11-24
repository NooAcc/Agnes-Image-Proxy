import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { adminHandlers, createAdminState } from "@/test/handlers";
import { renderApp } from "@/test/render";
import { startServer, type MockServer } from "@/test/server";

let server: MockServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

describe("settings", () => {
  it("persists the image link TTL and optional public origin", async () => {
    const state = createAdminState();
    server = startServer(adminHandlers(state));
    const view = renderApp(["/settings"]);
    const ttl = await screen.findByLabelText("图片链接有效期（小时）");
    expect(ttl).toHaveValue(24);
    expect(ttl).toHaveAttribute("min", "1");
    expect(ttl).toHaveAttribute("max", "720");
    expect(ttl).toHaveAttribute("step", "1");
    await userEvent.clear(ttl);
    await userEvent.type(ttl, "48");
    const origin = screen.getByLabelText("图片公网基础地址");
    await userEvent.type(origin, "https://images.example.com");
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await screen.findByText("设置已保存。");
    expect(state.settings.imageUrlTtlHours).toBe(48);
    expect(state.settings.imagePublicBaseUrl).toBe("https://images.example.com");
    view.unmount();
    renderApp(["/settings"]);
    expect(await screen.findByLabelText("图片链接有效期（小时）")).toHaveValue(48);
  });
  it("retains TTL input and focuses its field after a backend validation error", async () => {
    const state = createAdminState({ settingsError: { status: 400, message: "imageUrlTtlHours must be an integer between 1 and 720", param: "imageUrlTtlHours", code: "invalid_setting" } });
    server = startServer(adminHandlers(state));
    renderApp(["/settings"]);
    const ttl = await screen.findByLabelText("图片链接有效期（小时）");
    await userEvent.clear(ttl);
    await userEvent.type(ttl, "48");
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));
    const summary = await screen.findByRole("list", { name: "表单错误" });
    expect(ttl).toHaveValue(48);
    expect(ttl).toHaveAttribute("aria-invalid", "true");
    await userEvent.click(within(summary).getByRole("link", { name: "图片链接有效期（小时）" }));
    expect(ttl).toHaveFocus();
    expect(state.settings.imageUrlTtlHours).toBe(24);
    expect(state.settings.imagePublicBaseUrl).toBe("");
  });
  it("keeps the edited value and points at the failing field when PUT is rejected", async () => {
    const state = createAdminState({
      settingsError: {
        status: 400,
        message: "thumbnailWidth must be an integer between 128 and 2048",
        param: "thumbnailWidth",
        code: "invalid_setting",
      },
    });
    server = startServer(adminHandlers(state));
    renderApp(["/settings"]);

    const width = await screen.findByLabelText("缩略图宽度");
    await userEvent.clear(width);
    await userEvent.type(width, "999");
    await userEvent.click(screen.getByRole("button", { name: "保存设置" }));

    const summary = await screen.findByRole("alert", { name: "表单错误" });
    expect(summary).toHaveTextContent("thumbnailWidth must be an integer between 128 and 2048");
    expect(width).toHaveValue(999);
    expect(width).toHaveAttribute("aria-invalid", "true");

    const errorSummary = await screen.findByRole("list", { name: "表单错误" });
    expect(errorSummary).toHaveTextContent("缩略图宽度");
  });
});
