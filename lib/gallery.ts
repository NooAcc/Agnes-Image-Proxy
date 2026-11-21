import { isAllowedImageMime } from "./image-mime.ts";
import { bytesFromRow, type SqlArg, type SqlExecutor } from "./sql.ts";

export interface GalleryInsert {
  ts: string;
  endpoint: string;
  model: string;
  accountId: number | null;
  accountName: string | null;
  prompt: string;
  size: string | null;
  tier: string | null;
  ratio: string | null;
  mime: string;
  bytes: Uint8Array | null;
  sourceUrl: string | null;
}

export interface GalleryItem {
  id: number;
  ts: string;
  endpoint: string;
  model: string;
  accountId: number | null;
  accountName: string | null;
  prompt: string;
  size: string | null;
  tier: string | null;
  ratio: string | null;
  mime: string;
  byteSize: number;
  sourceUrl: string | null;
  archived: boolean;
  createdAt: string;
}

export interface GalleryPage {
  items: GalleryItem[];
  nextBefore: number | null;
}

export interface GalleryStore {
  record(input: GalleryInsert): Promise<number>;
  list(before: number | null, limit: number): Promise<GalleryPage>;
  content(id: number): Promise<{ mime: string; bytes: Uint8Array } | null>;
  remove(id: number): Promise<boolean>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

const LIST_COLUMNS = `id, ts, endpoint, model, account_id, account_name, prompt, size, tier, ratio,
  mime, byte_size, source_url, archived, created_at`;

function toItem(row: Record<string, unknown>): GalleryItem {
  return {
    id: Number(row.id),
    ts: String(row.ts),
    endpoint: String(row.endpoint),
    model: String(row.model),
    accountId: row.account_id === null ? null : Number(row.account_id),
    accountName: row.account_name === null ? null : String(row.account_name),
    prompt: String(row.prompt),
    size: row.size === null ? null : String(row.size),
    tier: row.tier === null ? null : String(row.tier),
    ratio: row.ratio === null ? null : String(row.ratio),
    mime: String(row.mime),
    byteSize: Number(row.byte_size),
    sourceUrl: row.source_url === null ? null : String(row.source_url),
    archived: Number(row.archived) === 1,
    createdAt: String(row.created_at),
  };
}

export function createGalleryStore(sql: SqlExecutor): GalleryStore {
  return {
    async record(input) {
      const bytes = input.bytes;
      const args: SqlArg[] = [
        input.ts,
        input.endpoint,
        input.model,
        input.accountId,
        input.accountName,
        input.prompt,
        input.size,
        input.tier,
        input.ratio,
        input.mime,
        bytes,
        bytes?.byteLength ?? 0,
        input.sourceUrl,
        bytes ? 1 : 0,
        new Date().toISOString(),
      ];
      const result = await sql.execute(
        `INSERT INTO gallery
          (ts, endpoint, model, account_id, account_name, prompt, size, tier, ratio,
           mime, bytes, byte_size, source_url, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        args,
      );
      return Number(result.rows[0].id);
    },

    async list(before, limit) {
      const fetch = Math.max(1, limit) + 1;
      const result = before === null
        ? await sql.execute(
          `SELECT ${LIST_COLUMNS} FROM gallery ORDER BY id DESC LIMIT ?`,
          [fetch],
        )
        : await sql.execute(
          `SELECT ${LIST_COLUMNS} FROM gallery WHERE id < ? ORDER BY id DESC LIMIT ?`,
          [before, fetch],
        );
      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(toItem);
      const nextBefore = hasMore && items.length > 0 ? items[items.length - 1].id : null;
      return { items, nextBefore };
    },

    async content(id) {
      const result = await sql.execute("SELECT mime, bytes FROM gallery WHERE id = ?", [id]);
      if (result.rows.length === 0) return null;
      const mime = String(result.rows[0].mime);
      if (!isAllowedImageMime(mime)) return null;
      const bytes = bytesFromRow(result.rows[0].bytes);
      if (bytes === null) return null;
      return { mime, bytes };
    },

    async remove(id) {
      const result = await sql.execute("DELETE FROM gallery WHERE id = ?", [id]);
      return result.rowsAffected > 0;
    },

    async clear() {
      await sql.execute("DELETE FROM gallery");
    },

    async count() {
      const result = await sql.execute("SELECT COUNT(*) AS c FROM gallery");
      return Number(result.rows[0]?.c ?? 0);
    },
  };
}
