import type { SqlExecutor } from "./sql.ts";

export interface ModelUsageInput {
  model: string;
  endpoint: string;
  day: string;
  ok: boolean;
  images: number;
  at: string;
}

export interface ModelUsageRow {
  requests: number;
  errors: number;
  images: number;
  lastUsedAt: string;
}

export interface ModelUsageStore {
  record(input: ModelUsageInput): Promise<void>;
  byDay(day: string): Promise<Map<string, ModelUsageRow>>;
}

export function createModelUsageStore(sql: SqlExecutor): ModelUsageStore {
  return {
    async record(input) {
      const requests = input.images > 0 ? 1 : 0;
      const errors = input.ok ? 0 : 1;
      await sql.execute(
        `INSERT INTO model_usage_daily (model, day, requests, errors, images, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (model, day) DO UPDATE SET
           requests = requests + excluded.requests,
           errors = errors + excluded.errors,
           images = images + excluded.images,
           last_used_at = excluded.last_used_at`,
        [input.model, input.day, requests, errors, input.images, input.at],
      );
    },

    async byDay(day) {
      const result = await sql.execute(
        "SELECT model, requests, errors, images, last_used_at FROM model_usage_daily WHERE day = ?",
        [day],
      );
      const rows = new Map<string, ModelUsageRow>();
      for (const row of result.rows) {
        rows.set(String(row.model), {
          requests: Number(row.requests),
          errors: Number(row.errors),
          images: Number(row.images),
          lastUsedAt: String(row.last_used_at),
        });
      }
      return rows;
    },
  };
}
