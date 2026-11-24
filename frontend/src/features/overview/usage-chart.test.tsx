import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageChart } from "@/features/overview/usage-chart";
import type { DailyUsage } from "@/lib/schemas";

function day(day: string, requests: number, images: number): DailyUsage {
  return { day, requests, successes: requests, partials: 0, failures: 0, images };
}

describe("UsageChart", () => {
  it("renders one axis with a matching table and a keyboard tooltip", () => {
    const days = [day("2026-11-20", 0, 0), day("2026-11-21", 4, 6)];
    render(<UsageChart days={days} metric="requests" />);

    const region = screen.getByRole("region", { name: "请求趋势" });
    const table = within(region).getByRole("table", { name: "请求逐日数据" });
    expect(within(table).getByText("2026-11-20")).toBeInTheDocument();
    expect(within(table).getByText("2026-11-21").closest("tr")).toHaveTextContent("4");

    const point = within(region).getByRole("button", { name: "2026-11-21：4" });
    fireEvent.focus(point);
    expect(within(region).getByRole("status")).toHaveTextContent("2026-11-21 · 4 请求");
  });

  it("accepts mouse selection as well", () => {
    render(<UsageChart days={[day("2026-11-20", 2, 3), day("2026-11-21", 5, 4)]} metric="images" />);
    const region = screen.getByRole("region", { name: "图片趋势" });
    fireEvent.mouseEnter(within(region).getByRole("button", { name: "2026-11-20：3" }));
    expect(within(region).getByRole("status")).toHaveTextContent("2026-11-20 · 3 图片");
  });

  it("distinguishes an empty range from all-zero days", () => {
    const { rerender } = render(<UsageChart days={[]} metric="requests" />);
    expect(screen.getByText("暂无数据")).toBeInTheDocument();

    rerender(<UsageChart days={[day("2026-11-20", 0, 0), day("2026-11-21", 0, 0)]} metric="requests" />);
    expect(screen.queryByText("暂无数据")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "请求趋势" })).toBeInTheDocument();
  });
});
