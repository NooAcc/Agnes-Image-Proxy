import { isAllowedImageMime } from "./image-mime.ts";
import { bytesFromRow, type SqlArg, type SqlExecutor } from "./sql.ts";

/** nsfw-detection-2-mini five-class scores plus its aggregate flag, as returned by Edge-Images. */
export interface NsfwScores {
  drawing: number;
  hentai: number;
  safe: number;
  porn: number;
  sexy: number;
  isNsfw: boolean;
}

export type GalleryTagFilter =
  | "safe"
  | "drawing"
  | "sexy"
  | "porn"
  | "hentai"
  | "uncategorized";

export interface EnrichmentWrite {
  thumb: Uint8Array | null;
  thumbMime: string | null;
  nsfw: NsfwScores | null;
  tag: string | null;
  status: "ok" | "failed";
  error: string | null;
  at: string;
}

export interface PendingEnrichmentRow {
  id: number;
  mime: string;
  byteSize: number;
}

export interface EnrichInput {
  id: number;
  mime: string;
  bytes: Uint8Array;
}

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
  tag: string | null;
  nsfw: NsfwScores | null;
  hasThumbnail: boolean;
  enrichStatus: "ok" | "failed" | null;
  enrichError: string | null;
}

export interface GalleryPage {
  items: GalleryItem[];
  nextBefore: number | null;
}

export interface GalleryStore {
  record(input: GalleryInsert): Promise<number>;
  list(
    before: number | null,
    limit: number,
    tag?: GalleryTagFilter | null,
  ): Promise<GalleryPage>;
  content(id: number): Promise<{ mime: string; bytes: Uint8Array } | null>;
  thumbnail(id: number): Promise<{ mime: string; bytes: Uint8Array } | null>;
  setEnrichment(id: number, input: EnrichmentWrite): Promise<void>;
  pendingEnrichment(before: number | null, limit: number): Promise<PendingEnrichmentRow[]>;
  readForEnrichment(ids: number[]): Promise<EnrichInput[]>;
  countPendingEnrichment(): Promise<number>;
  remove(id: number): Promise<boolean>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

const LIST_COLUMNS = `id, ts, endpoint, model, account_id, account_name, prompt, size, tier, ratio,
  mime, byte_size, source_url, archived, created_at, tag, nsfw, enrich_status, enrich_error,
  CASE WHEN thumb IS NULL THEN 0 ELSE 1 END AS has_thumb`;

function parseNsfw(value: unknown): NsfwScores | null {
  if (typeof value !== "string" || value === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as NsfwScores;
}

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
    tag: row.tag === null ? null : String(row.tag),
    nsfw: parseNsfw(row.nsfw),
    hasThumbnail: Number(row.has_thumb) === 1,
    enrichStatus: row.enrich_status === "ok"
      ? "ok"
      : row.enrich_status === "failed"
      ? "failed"
      : null,
    enrichError: row.enrich_error === null ? null : String(row.enrich_error),
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

    async list(before, limit, tag = null) {
      const fetch = Math.max(1, limit) + 1;
      const clauses: string[] = [];
      const args: SqlArg[] = [];
      if (tag === "uncategorized") clauses.push("tag IS NULL");
      else if (tag) {
        clauses.push("tag = ?");
        args.push(tag);
      }
      if (before !== null) {
        clauses.push("id < ?");
        args.push(before);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      args.push(fetch);
      const result = await sql.execute(
        `SELECT ${LIST_COLUMNS} FROM gallery ${where} ORDER BY id DESC LIMIT ?`,
        args,
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

    async thumbnail(id) {
      const result = await sql.execute(
        "SELECT thumb, thumb_mime FROM gallery WHERE id = ?",
        [id],
      );
      if (result.rows.length === 0) return null;
      const mime = result.rows[0].thumb_mime === null ? null : String(result.rows[0].thumb_mime);
      if (mime === null || !isAllowedImageMime(mime)) return null;
      const bytes = bytesFromRow(result.rows[0].thumb);
      if (bytes === null) return null;
      return { mime, bytes };
    },

    async setEnrichment(id, input) {
      await sql.execute(
        `UPDATE gallery SET thumb = ?, thumb_mime = ?, nsfw = ?, tag = ?, enrich_status = ?,
           enrich_error = ?, enriched_at = ? WHERE id = ?`,
        [
          input.thumb,
          input.thumbMime,
          input.nsfw === null ? null : JSON.stringify(input.nsfw),
          input.tag,
          input.status,
          input.error,
          input.at,
          id,
        ],
      );
    },

    async pendingEnrichment(before, limit) {
      const result = before === null
        ? await sql.execute(
          `SELECT id, mime, byte_size FROM gallery
           WHERE archived = 1 AND bytes IS NOT NULL
             AND (enrich_status IS NULL OR enrich_status = 'failed')
           ORDER BY id DESC LIMIT ?`,
          [limit],
        )
        : await sql.execute(
          `SELECT id, mime, byte_size FROM gallery
           WHERE archived = 1 AND bytes IS NOT NULL
             AND (enrich_status IS NULL OR enrich_status = 'failed')
             AND id < ?
           ORDER BY id DESC LIMIT ?`,
          [before, limit],
        );
      return result.rows.map((row) => ({
        id: Number(row.id),
        mime: String(row.mime),
        byteSize: Number(row.byte_size),
      }));
    },

    async readForEnrichment(ids) {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => "?").join(", ");
      const result = await sql.execute(
        `SELECT id, mime, bytes FROM gallery WHERE id IN (${placeholders})`,
        ids,
      );
      const inputs: EnrichInput[] = [];
      for (const row of result.rows) {
        const bytes = bytesFromRow(row.bytes);
        if (bytes === null) continue;
        inputs.push({ id: Number(row.id), mime: String(row.mime), bytes });
      }
      return inputs;
    },

    async countPendingEnrichment() {
      const result = await sql.execute(
        `SELECT COUNT(*) AS c FROM gallery
         WHERE archived = 1 AND bytes IS NOT NULL AND enrich_status IS NULL`,
      );
      return Number(result.rows[0]?.c ?? 0);
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
