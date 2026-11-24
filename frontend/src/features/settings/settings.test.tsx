import { screen } from "@testing-library/react";
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
