import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { adminHandlers, createAdminState, makeAccount } from "@/test/handlers";
import { renderApp } from "@/test/render";
import { startServer, errorResponse, type MockServer, type MockRequest } from "@/test/server";

let server: MockServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

function findCall(
  calls: MockRequest[],
  method: string,
  path: string,
): MockRequest | undefined {
  return [...calls].reverse().find((call) => call.method === method && call.path === path);
}

describe("accounts", () => {
  it("shows deletion failure and permits an explicit retry", async () => {
    const state = createAdminState({ accounts: [makeAccount({ id: 1, name: "primary" })] });
    server = startServer([(req) => req.method === "DELETE" ? errorResponse(503, "database unavailable") : undefined, ...adminHandlers(state)]);
    renderApp(["/accounts"]);
    await userEvent.click(await screen.findByRole("button", { name: "删除 primary" }));
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("database unavailable");
    expect(screen.getByText("primary")).toBeInTheDocument();
  });

  it("does not resend the old key when the key field is left empty", async () => {
    const state = createAdminState({ accounts: [makeAccount({ id: 1, name: "primary" })] });
    server = startServer(adminHandlers(state));
    renderApp(["/accounts"]);

    await userEvent.click(await screen.findByRole("button", { name: "编辑 primary" }));
    const nameInput = await screen.findByLabelText("名称");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "renamed");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(findCall(server!.calls, "PATCH", "/admin/api/accounts/1")).toBeDefined());
    const patch = findCall(server!.calls, "PATCH", "/admin/api/accounts/1");
    expect(patch?.body).toEqual({ name: "renamed" });
    expect(patch?.body).not.toHaveProperty("apiKey");
    expect(await screen.findByText("renamed")).toBeInTheDocument();
  });

  it("reports partial imports and never re-sends successful rows", async () => {
    const state = createAdminState({ importFailures: new Set([2]) });
    server = startServer(adminHandlers(state));
    renderApp(["/accounts"]);

    await userEvent.click(await screen.findByRole("button", { name: "导入" }));
    const textarea = await screen.findByLabelText("账号列表");
    fireEvent.change(textarea, {
      target: { value: "one,sk-one-1234\ntwo,sk-two-1234\nbad,sk-bad-1234" },
    });
    await userEvent.click(screen.getByRole("button", { name: "导入账号" }));

    expect(await screen.findByText(/已导入 2 个账号/)).toBeInTheDocument();
    const errors = await screen.findByRole("list", { name: "导入错误" });
    expect(within(errors).getByText(/第 3 行/)).toBeInTheDocument();
    expect(textarea).toHaveValue("bad,sk-bad-1234");

    await userEvent.click(screen.getByRole("button", { name: "导入账号" }));
    await waitFor(() => {
      const imports = server!.calls.filter(
        (call) => call.method === "POST" && call.path === "/admin/api/accounts/import",
      );
      expect(imports).toHaveLength(2);
      expect((imports[1].body as { accounts: unknown[] }).accounts).toHaveLength(1);
    });
  });
});
