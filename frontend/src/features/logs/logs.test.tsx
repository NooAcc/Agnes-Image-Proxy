import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { adminHandlers, createAdminState, makeLog } from "@/test/handlers";
import { renderApp } from "@/test/render";
import { startServer, type MockServer } from "@/test/server";

let server: MockServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

describe("logs", () => {
  it("filters by the URL-driven category and opens details", async () => {
    const state = createAdminState({
      logs: [
        makeLog({ id: 1, requestId: "req-request", category: "request" }),
        makeLog({ id: 2, requestId: "req-enrich", category: "enrich", stage: "archive" }),
      ],
    });
    server = startServer(adminHandlers(state));
    const { router } = renderApp(["/logs"]);

    expect(await screen.findByText("req-request")).toBeInTheDocument();
    expect(screen.queryByText("req-enrich")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "富化" }));
    await waitFor(() => expect(router.state.location.search).toContain("category=enrich"));
    expect(await screen.findByText("req-enrich")).toBeInTheDocument();
    expect(screen.queryByText("req-request")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "查看 req-enrich 详情" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/req-enrich/)).toBeInTheDocument();
    expect(within(dialog).getByText("archive")).toBeInTheDocument();
  });

  it("clears logs only after confirmation", async () => {
    const state = createAdminState({ logs: [makeLog({ id: 1, requestId: "req-request" })] });
    server = startServer(adminHandlers(state));
    renderApp(["/logs"]);

    await screen.findByText("req-request");
    await userEvent.click(screen.getByRole("button", { name: "清空日志" }));
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "清空日志" }));

    await waitFor(() => expect(screen.queryByText("req-request")).not.toBeInTheDocument());
  });
});
