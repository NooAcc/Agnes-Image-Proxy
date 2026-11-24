import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AppProviders } from "@/app/providers";
import { AppShell } from "@/app/shell";
import { setSystemPrefersDark } from "@/test/match-media";

function renderShell() {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={["/admin/overview"]}>
        <AppShell />
      </MemoryRouter>
    </AppProviders>,
  );
}

beforeEach(() => {
  setSystemPrefersDark(false);
  window.localStorage.clear();
});

describe("theme", () => {
  it("follows the system preference on first load", () => {
    setSystemPrefersDark(true);
    renderShell();
    expect(document.documentElement).toHaveClass("dark");
  });

  it("remembers an explicit dark choice across reloads", async () => {
    const user = userEvent.setup();
    const first = renderShell();
    expect(document.documentElement).not.toHaveClass("dark");

    await user.selectOptions(screen.getByLabelText("主题"), "dark");
    expect(document.documentElement).toHaveClass("dark");

    first.unmount();
    setSystemPrefersDark(false);
    renderShell();
    expect(document.documentElement).toHaveClass("dark");
  });
});

describe("navigation", () => {
  it("opens and closes the mobile navigation with the keyboard and restores focus", async () => {
    const user = userEvent.setup();
    renderShell();

    const trigger = screen.getByRole("button", { name: "打开导航" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "导航" });
    expect(within(dialog).getByRole("link", { name: "图库" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("exposes the main sections", () => {
    renderShell();
    for (const name of ["总览", "图库", "账号", "日志", "设置"]) {
      expect(screen.getAllByRole("link", { name }).length).toBeGreaterThan(0);
    }
  });

  it("gives every icon button an accessible name", () => {
    renderShell();
    for (const button of screen.getAllByRole("button")) {
      const name = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
