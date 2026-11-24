import { describe, expect, it } from "vitest";
import { BlobCache } from "@/lib/blob-cache";

function imageResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "image/png" } });
}

function makeCache(options: {
  maxEntries?: number;
  maxBytes?: number;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) {
  const created: string[] = [];
  const revoked: string[] = [];
  let counter = 0;
  const cache = new BlobCache({
    maxEntries: options.maxEntries ?? 16,
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    fetchImpl: options.fetchImpl ?? (async () => imageResponse("AB")),
    createURL: () => {
      counter += 1;
      const url = `blob:mock-${counter}`;
      created.push(url);
      return url;
    },
    revokeURL: (url) => revoked.push(url),
  });
  return { cache, created, revoked };
}

describe("BlobCache", () => {
  it("keeps evicted URLs alive until mounted consumers release their leases", async () => {
    const { cache, revoked } = makeCache({ maxEntries: 1 });
    const first = await cache.load(1, "thumbnail");
    const second = await cache.load(2, "thumbnail");
    expect(revoked).not.toContain(first.url);
    first.release();
    expect(revoked).toContain(first.url);
    second.release();
    cache.clear();
  });

  it("evicts the least recently used entry when full", async () => {
    const { cache, revoked } = makeCache({ maxEntries: 2 });
    const first = await cache.load(1, "thumbnail");
    first.release();
    await cache.load(2, "thumbnail");
    await cache.load(3, "thumbnail");

    expect(cache.size).toBe(2);
    expect(revoked).toEqual([first.url]);
    const again = await cache.load(2, "thumbnail");
    expect(again.cached).toBe(true);
  });

  it("does not cache a blob larger than the byte budget", async () => {
    const { cache, revoked } = makeCache({ maxBytes: 1 });
    const result = await cache.load(1, "image");
    expect(result.cached).toBe(false);
    expect(cache.size).toBe(0);
    result.release();
    expect(revoked).toEqual([result.url]);
  });

  it("evicts by total bytes as well as entry count", async () => {
    const { cache, revoked } = makeCache({ maxEntries: 16, maxBytes: 5 });
    const first = await cache.load(1, "image"); // 2 bytes
    first.release();
    await cache.load(2, "image"); // 2 bytes
    await cache.load(3, "image"); // 2 bytes -> evict 1
    expect(cache.size).toBe(2);
    expect(revoked).toContain(first.url);
  });

  it("deduplicates concurrent loads of the same key", async () => {
    let calls = 0;
    const { cache } = makeCache({
      fetchImpl: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return imageResponse("AB");
      },
    });
    const [a, b] = await Promise.all([
      cache.load(7, "thumbnail"),
      cache.load(7, "thumbnail"),
    ]);
    expect(calls).toBe(1);
    expect(a.url).toBe(b.url);
  });

  it("clears every cached URL and revokes it", async () => {
    const { cache, revoked } = makeCache({});
    const a = await cache.load(1, "image");
    const b = await cache.load(2, "thumbnail");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(revoked.sort()).toEqual([a.url, b.url].sort());
    const next = await cache.load(1, "image");
    expect(next.url).not.toBe(a.url);
  });

  it("surfaces HTTP failures without creating URLs", async () => {
    const { cache, created } = makeCache({
      fetchImpl: async () => new Response("missing", { status: 404 }),
    });
    await expect(cache.load(9, "thumbnail")).rejects.toMatchObject({ status: 404 });
    expect(created).toEqual([]);
    expect(cache.size).toBe(0);
  });
});
