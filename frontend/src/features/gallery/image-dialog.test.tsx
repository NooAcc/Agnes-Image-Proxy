import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageDialog } from "@/features/gallery/image-dialog";
import { blobCache } from "@/lib/blob-cache";
import type { GalleryItem } from "@/lib/schemas";
import { startServer, type MockServer, type MockRequest } from "@/test/server";

let created: string[];
let revoked: string[];
let server: MockServer | undefined;

function makeItem(overrides: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id: 1,
    createdAt: "2026-11-24T10:00:00Z",
    requestId: "req-1",
    model: "agnes-image-2.5-flash",
    prompt: "first",
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

function binary(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "image/png" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function callsTo(path: string): MockRequest[] {
  return server?.calls.filter((call) => call.path === path) ?? [];
}

beforeEach(() => {
  created = [];
  revoked = [];
  let counter = 0;
  Object.assign(URL, {
    createObjectURL: () => {
      counter += 1;
      const url = `blob:mock-${counter}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  });
});

afterEach(() => {
  server?.stop();
  server = undefined;
  blobCache.clear();
});

describe("ImageDialog", () => {
  it("loads original content even when a valid thumbnail exists", async () => {
    server = startServer([(request) => request.path.endsWith("/content") ? binary("original") : binary("thumbnail")]);
    render(<ImageDialog item={makeItem()} onClose={() => {}} />);
    await screen.findByAltText("first");
    expect(callsTo("/admin/api/gallery/1/content")).toHaveLength(1);
    expect(callsTo("/admin/api/gallery/1/thumbnail")).toHaveLength(0);
  });

  it("never shows a late image after switching to another one", async () => {
    const firstThumb = deferred<Response>();
    server = startServer([
      (request) => {
        if (request.path === "/admin/api/gallery/1/content") return firstThumb.promise;
        if (request.path === "/admin/api/gallery/2/content") return binary("second");
        return undefined;
      },
    ]);

    const first = makeItem({ id: 1, prompt: "first" });
    const second = makeItem({ id: 2, prompt: "second" });
    const view = render(<ImageDialog key={1} item={first} onClose={() => {}} />);
    await waitFor(() => expect(callsTo("/admin/api/gallery/1/content")).toHaveLength(1));

    view.rerender(<ImageDialog key={2} item={second} onClose={() => {}} />);
    const image = await screen.findByAltText("second");
    await waitFor(() => expect(image).toHaveAttribute("src", created[0]));
    expect(screen.queryByAltText("first")).not.toBeInTheDocument();

    firstThumb.resolve(binary("first"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByAltText("second")).toHaveAttribute("src", created[0]);
    expect(screen.queryByAltText("first")).not.toBeInTheDocument();
  });

  it("requests original once without consulting missing thumbnails", async () => {
    server = startServer([
      (request) => {
        if (request.path.endsWith("/thumbnail")) return binary("missing", 404);
        if (request.path.endsWith("/content")) return binary("original");
        return undefined;
      },
    ]);
    render(<ImageDialog item={makeItem({ prompt: "fallback" })} onClose={() => {}} />);

    const image = await screen.findByAltText("fallback");
    expect(image).toHaveAttribute("src", created[0]);
    expect(callsTo("/admin/api/gallery/1/thumbnail")).toHaveLength(0);
    expect(callsTo("/admin/api/gallery/1/content")).toHaveLength(1);
  });

  it("shows an error instead of looping when both sources fail", async () => {
    server = startServer([
      () => binary("missing", 404),
    ]);
    render(<ImageDialog item={makeItem({ prompt: "broken" })} onClose={() => {}} />);

    expect(await screen.findByText("图片加载失败")).toBeInTheDocument();
    await waitFor(() => expect(server!.calls).toHaveLength(1));
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("offers a safe download link and unarchived source information", async () => {
    server = startServer([() => binary("original")]);
    render(<ImageDialog item={makeItem({ id: 5 })} onClose={() => {}} />);

    await screen.findByAltText("first");
    const download = screen.getByRole("link", { name: "下载原图" });
    expect(download).toHaveAttribute("href", "/admin/api/gallery/5/content?download=1");
    expect(download).not.toHaveAttribute("download");
  });

  it("explains unarchived rows without fetching an image", async () => {
    server = startServer([() => binary("unexpected")]);
    render(
      <ImageDialog
        item={makeItem({ archived: false, sourceUrl: "https://img.example/x.png" })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("未归档")).toBeInTheDocument();
    const source = screen.getByRole("link", { name: "打开源链接" });
    expect(source).toHaveAttribute("href", "https://img.example/x.png");
    expect(source).toHaveAttribute("rel", "noopener noreferrer");
    expect(server.calls).toHaveLength(0);
  });
});
