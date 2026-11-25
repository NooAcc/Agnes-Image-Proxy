import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { adminHandlers, createAdminState, makeLog } from "@/test/handlers";
import { startServer, errorResponse, type MockServer } from "@/test/server";
import type { GalleryItem } from "@/lib/schemas";
import { blobCache } from "@/lib/blob-cache";

let server: MockServer | undefined;

function galleryItem(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: 1,
    createdAt: "2026-11-24T10:00:00Z",
    requestId: "req-1",
    model: "agnes-image-2.5-flash",
    prompt: "safe picture",
    size: "1024x1024",
    accountName: "primary",
    nsfwTag: "safe",
    nsfwScores: null,
    enrichStatus: "success",
    archived: true,
    sourceUrl: null,
    ...overrides,
  };
}

function galleryState(items: GalleryItem[]) {
  const state = createAdminState({
    gallery: { items, nextBefore: null },
    images: new Map(items.map((item) => [item.id, `original-${item.id}`])),
    thumbnails: new Map(items.map((item) => [item.id, `thumb-${item.id}`])),
  });
  return state;
}

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: () => `blob:gallery-${Math.random()}`,
    revokeObjectURL: () => {},
  });
});

afterEach(() => {
  server?.stop();
  server = undefined;
  blobCache.clear();
  vi.restoreAllMocks();
});

describe("gallery", () => {
  it("filters by URL tag and never mixes a late page from the previous tag", async () => {
    const safe = galleryItem({ id: 1, prompt: "safe picture", nsfwTag: "safe" });
    const porn = galleryItem({ id: 2, prompt: "porn picture", nsfwTag: "porn" });
    const state = galleryState([safe, porn]);
    const base = adminHandlers(state);
    server = startServer([
      async (request) => {
        if (request.path === "/admin/api/gallery" && request.search.get("tag") === "safe") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return undefined;
        }
        return undefined;
      },
      ...base,
    ]);
    const { router } = renderApp(["/gallery?tag=safe"]);

    expect(await screen.findByAltText("safe picture")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("标签"), "porn");

    expect(await screen.findByAltText("porn picture")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toContain("tag=porn"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByAltText("safe picture")).not.toBeInTheDocument();
  });

  it("loads more pages with the keyset cursor", async () => {
    const newer = galleryItem({ id: 2, prompt: "newer picture" });
    const older = galleryItem({ id: 1, prompt: "older picture" });
    const sessionState = createAdminState();
    sessionState.images.set(1, "original").set(2, "original");
    sessionState.thumbnails.set(1, "thumb").set(2, "thumb");
    const sessionHandlers = adminHandlers(sessionState);
    server = startServer([
      (request) => {
        if (request.path !== "/admin/api/gallery") return undefined;
        if (request.search.get("before") === "2") {
          return new Response(JSON.stringify({ items: [older], nextBefore: null }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ items: [newer], nextBefore: 2 }), {
          headers: { "Content-Type": "application/json" },
        });
      },
      ...sessionHandlers,
    ]);
    renderApp(["/gallery"]);

    expect(await screen.findByAltText("newer picture")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByAltText("older picture")).toBeInTheDocument();
    expect(screen.getByAltText("newer picture")).toBeInTheDocument();
  });

  it("disables enrichment while the server reports running and restores counts", async () => {
    const state = createAdminState({
      backfill: {
        running: true,
        startedAt: "2026-11-24T10:00:00Z",
        finishedAt: null,
        processed: 3,
        succeeded: 2,
        failed: 1,
        error: null,
      },
      gallery: { items: [galleryItem()], nextBefore: null },
    });
    state.images.set(1, "original");
    state.thumbnails.set(1, "thumb");
    server = startServer(adminHandlers(state));
    renderApp(["/gallery"]);

    expect(await screen.findByText(/已处理 3 项/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "补齐中…" })).toBeDisabled();

    const galleryCallsBefore = server.calls.filter(
      (call) => call.method === "GET" && call.path === "/admin/api/gallery",
    ).length;
    state.backfill = { ...state.backfill, running: false, finishedAt: "2026-11-24T10:00:05Z" };

    await waitFor(
      () => {
        const calls = server!.calls.filter(
          (call) => call.method === "GET" && call.path === "/admin/api/gallery",
        ).length;
        expect(calls).toBeGreaterThan(galleryCallsBefore);
      },
      { timeout: 4_000 },
    );
    expect(screen.getByRole("button", { name: "补齐元数据" })).toBeEnabled();
    expect(await screen.findByText(/富化完成：处理 3 项/)).toBeInTheDocument();
  }, 10_000);

  it("does not announce a fake success for an empty pass", async () => {
    const state = createAdminState({
      backfill: {
        running: true,
        startedAt: "2026-11-24T10:00:00Z",
        finishedAt: null,
        processed: 0,
        succeeded: 0,
        failed: 0,
        error: null,
      },
    });
    server = startServer(adminHandlers(state));
    renderApp(["/gallery"]);

    expect(await screen.findByText(/已处理 0 项/)).toBeInTheDocument();
    state.backfill = { ...state.backfill, running: false, finishedAt: "2026-11-24T10:00:05Z" };

    expect(await screen.findByText("没有需要补齐的图片", {}, { timeout: 4_000 })).toBeInTheDocument();
  }, 10_000);

  it("deletes one image after confirmation and clears the gallery separately", async () => {
    const state = galleryState([galleryItem({ id: 1, prompt: "delete me" })]);
    state.logs = [makeLog({ id: 1, requestId: "keep-log" })];
    server = startServer(adminHandlers(state));
    renderApp(["/gallery"]);

    await screen.findByAltText("delete me");
    await userEvent.click(screen.getByRole("button", { name: "删除图片 #1" }));
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(screen.queryByAltText("delete me")).not.toBeInTheDocument());
    expect(
      server.calls.some(
        (call) => call.method === "DELETE" && call.path === "/admin/api/gallery/1",
      ),
    ).toBe(true);
    expect(state.logs).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "清空图库" }));
    const clearConfirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(clearConfirm).getByRole("button", { name: "清空图库" }));
    await waitFor(() =>
      expect(
        server!.calls.some((call) => call.method === "DELETE" && call.path === "/admin/api/gallery"),
      ).toBe(true),
    );
    expect(state.logs).toHaveLength(1);
  });

  it("explains that a failed clear is partial and retry continues", async () => {
    const state = galleryState([galleryItem({ id: 1, prompt: "partial clear" })]);
    server = startServer([
      (request) =>
        request.path === "/admin/api/gallery" && request.method === "DELETE"
          ? errorResponse(503, "original image storage unavailable", null, "image_storage_unavailable")
          : undefined,
      ...adminHandlers(state),
    ]);
    renderApp(["/gallery"]);

    await screen.findByAltText("partial clear");
    await userEvent.click(screen.getByRole("button", { name: "清空图库" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/可能只完成一部分/)).toBeVisible();
    await userEvent.click(within(confirm).getByRole("button", { name: "清空图库" }));

    expect(
      await within(confirm).findByText(/清空可能只完成了一部分，重试会继续清理剩余图片/),
    ).toBeVisible();
  });
});
