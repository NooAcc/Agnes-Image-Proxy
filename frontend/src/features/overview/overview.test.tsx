import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Overview } from "@/lib/schemas";
import { adminHandlers, createAdminState, makeOverview } from "@/test/handlers";
import { renderApp } from "@/test/render";
import { startServer, type MockServer } from "@/test/server";

let server: MockServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

function overviewFixture(days = [{ day: "2026-11-21", requests: 4, successes: 3, partials: 1, failures: 1, images: 6 }]): Overview {
  return makeOverview({
    startDay: "2026-11-20",
    endDay: "2026-11-22",
    totals: { requests: 5, successes: 3, partials: 2, failures: 2, images: 4 },
    days,
    models: [
      { model: "agnes-image-2.5-flash", requests: 5, successes: 3, partials: 2, failures: 2, images: 4 },
    ],
    accounts: { total: 3, healthy: 2, cooling: 1, disabled: 0 },
  });
}

describe("overview", () => {
  it("shows successes separately from requests and zero-fills missing UTC days", async () => {
    const state = createAdminState({ overview: overviewFixture() });
    server = startServer(adminHandlers(state));
    renderApp(["/overview?start=2026-11-20&end=2026-11-22"]);

    const totals = await screen.findByRole("region", { name: "总量指标" });
    expect(within(totals).getByText("请求").parentElement).toHaveTextContent("5");
    expect(within(totals).getByText("成功").parentElement).toHaveTextContent("3");
    expect(within(totals).getByText("部分成功").parentElement).toHaveTextContent("2");
    expect(within(totals).getByText("失败").parentElement).toHaveTextContent("2");
    expect(within(totals).getByText("图片").parentElement).toHaveTextContent("4");

    const requests = screen.getByRole("region", { name: "请求趋势" });
    expect(within(requests).getByText("2026-11-20")).toBeInTheDocument();
    expect(within(requests).getByText("2026-11-21")).toBeInTheDocument();
    expect(within(requests).getByText("2026-11-22")).toBeInTheDocument();
    const row20 = within(requests).getByText("2026-11-20").closest("tr");
    expect(row20).toHaveTextContent("0");
    const row21 = within(requests).getByText("2026-11-21").closest("tr");
    expect(row21).toHaveTextContent("4");

    const images = screen.getByRole("region", { name: "图片趋势" });
    expect(within(images).getByText("2026-11-21").closest("tr")).toHaveTextContent("6");

    const models = screen.getByRole("region", { name: "模型用量" });
    expect(within(models).getByText("agnes-image-2.5-flash")).toBeInTheDocument();
    expect(within(models).getByText("合计")).toBeInTheDocument();

    const health = screen.getByRole("region", { name: "账号健康" });
    expect(health).toHaveTextContent("3");
    expect(health).toHaveTextContent("2");
  });

  it("keeps the date range in the URL and reloads when it changes", async () => {
    const state = createAdminState({ overview: overviewFixture() });
    server = startServer(adminHandlers(state));
    const { router } = renderApp(["/overview?start=2026-11-20&end=2026-11-22"]);

    const start = await screen.findByLabelText("开始日期");
    await userEvent.clear(start);
    await userEvent.type(start, "2026-11-19");
    await userEvent.click(screen.getByRole("button", { name: "应用" }));

    await waitFor(() => expect(router.state.location.search).toContain("start=2026-11-19"));
    expect(router.state.location.search).toContain("end=2026-11-22");
    await waitFor(() =>
      expect(
        server!.calls.some(
          (call) => call.path === "/admin/api/overview" && call.search.get("start") === "2026-11-19",
        ),
      ).toBe(true),
    );
  });
});
