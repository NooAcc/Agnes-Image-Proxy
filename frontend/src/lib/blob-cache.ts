import { ApiError, notifyUnauthorized, currentSessionGeneration } from "./api";

export type BlobKind = "image" | "thumbnail";
export interface BlobResult {
  url: string;
  bytes: number;
  cached: boolean;
  /** Releases this consumer's lease; cache retention is independent. */
  release: () => void;
}
export interface BlobCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  createURL: (blob: Blob) => string;
  revokeURL: (url: string) => void;
}
interface Entry {
  url: string;
  bytes: number;
  refs: number;
  retained: boolean;
  revoked: boolean;
}

// LRU bounds retained cache data, not URLs actively leased by mounted images.
// Logout/clear is an explicit invalidation and revokes all active URLs too.
export class BlobCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: BlobCacheOptions["fetchImpl"];
  private readonly createURL: BlobCacheOptions["createURL"];
  private readonly revokeURL: BlobCacheOptions["revokeURL"];
  private readonly entries = new Map<string, Entry>();
  private readonly live = new Set<Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private totalBytes = 0;
  private generation = 0;

  constructor(options: BlobCacheOptions) {
    this.maxEntries = options.maxEntries ?? 16;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl;
    this.createURL = options.createURL;
    this.revokeURL = options.revokeURL;
  }
  get size(): number { return this.entries.size; }
  get bytes(): number { return this.totalBytes; }

  async load(id: number, kind: BlobKind, signal?: AbortSignal): Promise<BlobResult> {
    const key = `${kind}:${id}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return this.lease(cached);
    }
    const pending = this.inflight.get(key);
    if (pending) return this.lease(await pending);
    const promise = this.fetchEntry(key, id, kind, signal, this.generation);
    this.inflight.set(key, promise);
    let entry: Entry | undefined;
    try {
      entry = await promise;
      return this.lease(entry);
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
      if (entry) {
        entry.refs -= 1; // release in-flight ownership, not a consumer lease
        this.collect(entry);
      }
    }
  }

  clear(): void {
    this.generation += 1;
    this.inflight.clear();
    for (const entry of this.live) this.revoke(entry);
    this.entries.clear();
    this.totalBytes = 0;
  }
  remove(id: number): void {
    this.evict(`image:${id}`);
    this.evict(`thumbnail:${id}`);
  }

  private lease(entry: Entry): BlobResult {
    if (entry.revoked) throw new DOMException("Image invalidated", "AbortError");
    entry.refs += 1;
    let released = false;
    return {
      url: entry.url, bytes: entry.bytes, cached: entry.retained,
      release: () => {
        if (released) return;
        released = true;
        entry.refs -= 1;
        this.collect(entry);
      },
    };
  }

  private async fetchEntry(key: string, id: number, kind: BlobKind, signal: AbortSignal | undefined, generation: number): Promise<Entry> {
    const path = `/admin/api/gallery/${id}/${kind === "image" ? "content" : "thumbnail"}`;
    const session = currentSessionGeneration();
    const response = await this.fetchImpl(path, { signal, credentials: "same-origin" });
    if (!response.ok) {
      let message = response.statusText || "图片加载失败";
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch { /* Keep status text for non-JSON errors. */ }
      if (response.status === 401) notifyUnauthorized(session);
      throw new ApiError(response.status, message);
    }
    const blob = await response.blob();
    if (generation !== this.generation) throw new DOMException("Image invalidated", "AbortError");
    const entry: Entry = { url: this.createURL(blob), bytes: blob.size, refs: 1, retained: false, revoked: false };
    this.live.add(entry);
    if (entry.bytes > this.maxBytes) return entry;
    while (this.entries.size > 0 && (this.entries.size >= this.maxEntries || this.totalBytes + entry.bytes > this.maxBytes)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
    entry.retained = true;
    this.entries.set(key, entry);
    this.totalBytes += entry.bytes;
    return entry;
  }
  private evict(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    entry.retained = false;
    this.collect(entry);
  }
  private collect(entry: Entry): void {
    if (!entry.retained && entry.refs === 0) this.revoke(entry);
  }
  private revoke(entry: Entry): void {
    if (!entry.revoked) this.revokeURL(entry.url);
    entry.revoked = true;
    this.live.delete(entry);
  }
}

export const blobCache = new BlobCache({
  fetchImpl: (input, init) => fetch(input, init),
  createURL: (blob) => URL.createObjectURL(blob),
  revokeURL: (url) => URL.revokeObjectURL(url),
});
