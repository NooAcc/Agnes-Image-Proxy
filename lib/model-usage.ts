import type { SqlExecutor } from "./sql.ts";

export interface ModelUsageInput {
  model: string;
  day: string;
  images: number;
  requested: number | null;
  failed: number;
  at: string;
}

export interface ModelUsageRow {
  requests: number;
  successes: number;
  partials: number;
  failures: number;
  images: number;
  lastUsedAt: string;
}

export interface ModelUsageTotals {
  requests: number;
  successes: number;
  partials: number;
  failures: number;
  images: number;
}

export interface ModelUsageStore {
  record(input: ModelUsageInput): Promise<void>;
  byDay(day: string): Promise<Map<string, ModelUsageRow>>;
  /** Daily totals across every model for an inclusive UTC day range. */
  byRange(startDay: string, endDay: string): Promise<Map<string, ModelUsageTotals>>;
}

export function createModelUsageStore(sql: SqlExecutor): ModelUsageStore {
  return {
    async record(input) {
      const requests = 1;
      const successes = input.images > 0 ? 1 : 0;
      const partials = input.images > 0 && input.failed > 0 ? 1 : 0;
      const failures = input.images === 0 ? 1 : 0;
      await sql.execute(
        `INSERT INTO model_usage_daily
           (model, day, requests, successes, partials, failures, images, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (model, day) DO UPDATE SET
           requests = requests + excluded.requests,
           successes = successes + excluded.successes,
           partials = partials + excluded.partials,
           failures = failures + excluded.failures,
           images = images + excluded.images,
           last_used_at = excluded.last_used_at`,
        [
          input.model,
          input.day,
          requests,
          successes,
          partials,
          failures,
          input.images,
          input.at,
        ],
      );
    },

    async byDay(day) {
      const result = await sql.execute(
        `SELECT model, requests, successes, partials, failures, images, last_used_at
           FROM model_usage_daily WHERE day = ?`,
        [day],
      );
      const rows = new Map<string, ModelUsageRow>();
      for (const row of result.rows) {
        rows.set(String(row.model), {
          requests: Number(row.requests),
          successes: Number(row.successes),
          partials: Number(row.partials),
          failures: Number(row.failures),
          images: Number(row.images),
          lastUsedAt: String(row.last_used_at),
        });
      }
      return rows;
    },

    async byRange(startDay, endDay) {
      const result = await sql.execute(
        `SELECT day,
                SUM(requests) AS requests,
                SUM(successes) AS successes,
                SUM(partials) AS partials,
                SUM(failures) AS failures,
                SUM(images) AS images
           FROM model_usage_daily
          WHERE day >= ? AND day <= ?
          GROUP BY day`,
        [startDay, endDay],
      );
      const days = new Map<string, ModelUsageTotals>();
      for (const row of result.rows) {
        days.set(String(row.day), {
          requests: Number(row.requests),
          successes: Number(row.successes),
          partials: Number(row.partials),
          failures: Number(row.failures),
          images: Number(row.images),
        });
      }
      return days;
    },
  };
}
