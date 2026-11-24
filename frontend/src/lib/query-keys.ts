import type { LogCategory } from "./contracts";

export const queryKeys = {
  session: ["session"] as const,
  accounts: ["accounts"] as const,
  settings: ["settings"] as const,
  logs: (category: LogCategory, before: number | null) => ["logs", category, before] as const,
  overview: (start: string | null, end: string | null) => ["overview", start, end] as const,
  gallery: (tag: string | null) => ["gallery", "list", tag] as const,
  backfill: ["gallery", "enrich"] as const,
};
