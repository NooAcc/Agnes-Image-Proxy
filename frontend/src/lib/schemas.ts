import { z } from "zod";

// Schemas mirror internal/httpapi DTOs (camelCase). The shared fixture at
// internal/httpapi/testdata/admin-contracts.json is validated by schemas.test.

export const sessionSchema = z.object({
  authenticated: z.boolean(),
});

export const accountStatusSchema = z.enum(["healthy", "cooling", "disabled"]);

export const accountSummarySchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  apiKeyMasked: z.string(),
  enabled: z.boolean(),
  status: accountStatusSchema,
  cooldownUntil: z.string().nullable(),
  failCount: z.number().int().nonnegative(),
  lastUsedAt: z.string().nullable(),
  upstreamRequests: z.number().int().nonnegative(),
  upstreamImages: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export const accountListSchema = z.object({
  items: z.array(accountSummarySchema),
});

export const importResponseSchema = z.object({
  imported: z.number().int().nonnegative(),
  errors: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      message: z.string(),
    }),
  ),
});

export const probeResultSchema = z.object({
  id: z.number().int().positive(),
  ok: z.boolean(),
  status: z.number().int(),
  message: z.string(),
});

export const probeListSchema = z.object({
  items: z.array(probeResultSchema),
});

export const settingsSchema = z.object({
  agnesBaseUrl: z.string().min(1),
  defaultSize: z.enum(["1K", "2K", "3K", "4K"]),
  imageParamMode: z.enum(["nested", "top_level"]),
  probeModel: z.string().min(1),
  probeConcurrency: z.number().int().min(1).max(10),
  requestTimeoutMs: z.number().int().min(60_000).max(360_000),
  autoRefreshIntervalMs: z.number().int().min(2_000).max(60_000),
  maxAttempts: z.number().int().min(1).max(10),
  imageServiceBaseUrl: z.string(),
  thumbnailWidth: z.number().int().min(128).max(2_048),
  thumbnailQuality: z.number().int().min(40).max(100),
  enrichTimeoutMs: z.number().int().min(5_000).max(60_000),
  imageUrlTtlHours: z.number().int().min(1).max(720),
  imagePublicBaseUrl: z.string(),
});

export const attemptSchema = z.object({
  index: z.number().int(),
  accountId: z.number().int(),
  accountName: z.string(),
  status: z.number().int(),
  code: z.string(),
  durationMs: z.number().int(),
  message: z.string(),
});

export const logCategorySchema = z.enum(["request", "enrich"]);

export const requestLogSchema = z.object({
  id: z.number().int(),
  requestId: z.string(),
  ts: z.string(),
  category: logCategorySchema,
  stage: z.string(),
  endpoint: z.string(),
  path: z.string(),
  model: z.string(),
  status: z.number().int(),
  ok: z.boolean(),
  requested: z.number().int(),
  images: z.number().int(),
  failed: z.number().int(),
  durationMs: z.number().int(),
  sizeRequest: z.string().nullable(),
  sizeActual: z.string().nullable(),
  attempts: z.array(attemptSchema),
  partial: z.boolean(),
  deliveryFailures: z.array(z.object({
    subrequestIndex: z.number().int(),
    imageIndex: z.number().int(),
    stage: z.enum(["download", "persist"]),
    status: z.number().int(),
    code: z.string(),
  })),
});

export function pageSchema<Item extends z.ZodTypeAny>(item: Item) {
  return z.object({
    items: z.array(item),
    nextBefore: z.number().int().nullable(),
  });
}

export const logPageSchema = pageSchema(requestLogSchema);

export const usageTotalsSchema = z.object({
  requests: z.number().int(),
  successes: z.number().int(),
  partials: z.number().int(),
  failures: z.number().int(),
  images: z.number().int(),
});

export const overviewSchema = z.object({
  startDay: z.string(),
  endDay: z.string(),
  totals: usageTotalsSchema,
  days: z.array(usageTotalsSchema.extend({ day: z.string() })),
  models: z.array(usageTotalsSchema.extend({ model: z.string() })),
  accounts: z.object({
    total: z.number().int(),
    healthy: z.number().int(),
    cooling: z.number().int(),
    disabled: z.number().int(),
  }),
});

const nsfwTagSchema = z.preprocess(
  (value) => (value === "" ? "unclassified" : value),
  z.enum(["safe", "drawing", "sexy", "porn", "hentai", "unclassified"]),
);

export const nsfwScoresSchema = z.object({
  drawing: z.number(),
  hentai: z.number(),
  safe: z.number(),
  porn: z.number(),
  sexy: z.number(),
  isNsfw: z.boolean(),
});

export const galleryItemSchema = z.object({
  id: z.number().int(),
  createdAt: z.string(),
  requestId: z.string(),
  model: z.string(),
  prompt: z.string(),
  size: z.string(),
  accountName: z.string(),
  nsfwTag: nsfwTagSchema,
  nsfwScores: nsfwScoresSchema.nullable(),
  enrichStatus: z.enum(["pending", "success", "failed"]),
  archived: z.boolean(),
  sourceUrl: z.string().nullable(),
});

export const galleryPageSchema = pageSchema(galleryItemSchema);

export const backfillStatusSchema = z.object({
  running: z.boolean(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  processed: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  error: z.string().nullable(),
});

const storageUninitializedSchema = z.object({ initialized: z.literal(false) }).strict();
const storageLocalSchema = z
  .object({ initialized: z.literal(true), mode: z.literal("local") })
  .strict();
const storageImgbedSchema = z
  .object({
    initialized: z.literal(true),
    mode: z.literal("imgbed"),
    imgbedBaseUrl: z.string().url(),
    hasImgbedToken: z.boolean(),
  })
  .strict();

export const storageStatusSchema = z.union([
  storageUninitializedSchema,
  storageLocalSchema,
  storageImgbedSchema,
]);

export const storageInitSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local") }).strict(),
  z
    .object({
      mode: z.literal("imgbed"),
      imgbedBaseUrl: z.string().min(1),
      imgbedToken: z.string().min(1),
    })
    .strict(),
]);

export const storageUpdateSchema = z
  .object({
    imgbedBaseUrl: z.string().min(1),
    imgbedToken: z.string().optional(),
  })
  .strict();

export const loginRequestSchema = z
  .object({ apiKey: z.string().min(1) })
  .strict();

export const accountCreateSchema = z
  .object({ name: z.string().min(1), apiKey: z.string().min(1) })
  .strict();

export const accountPatchSchema = z
  .object({
    name: z.string().optional(),
    apiKey: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const importRequestSchema = z
  .object({
    accounts: z.array(accountCreateSchema).max(1_000),
  })
  .strict();

export type Session = z.infer<typeof sessionSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type AccountSummary = z.infer<typeof accountSummarySchema>;
export type AccountPatch = z.infer<typeof accountPatchSchema>;
export type ProbeResult = z.infer<typeof probeResultSchema>;
export type ImportAccountsResult = z.infer<typeof importResponseSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type LogCategory = z.infer<typeof logCategorySchema>;
export type RequestLog = z.infer<typeof requestLogSchema>;
export type Page<T> = { items: T[]; nextBefore: number | null };
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type DailyUsage = z.infer<typeof overviewSchema>["days"][number];
export type ModelUsage = z.infer<typeof overviewSchema>["models"][number];
export type AccountHealth = z.infer<typeof overviewSchema>["accounts"];
export type Overview = z.infer<typeof overviewSchema>;
export type NsfwTag = z.infer<typeof nsfwTagSchema>;
export type NsfwScores = z.infer<typeof nsfwScoresSchema>;
export type GalleryItem = z.infer<typeof galleryItemSchema>;
export type BackfillStatus = z.infer<typeof backfillStatusSchema>;
export type StorageStatus = z.infer<typeof storageStatusSchema>;
export type StorageInit = z.infer<typeof storageInitSchema>;
export type StorageUpdate = z.infer<typeof storageUpdateSchema>;

export const adminContractSchemas = {
  session: sessionSchema,
  accountSummary: accountSummarySchema,
  accountList: accountListSchema,
  importResponse: importResponseSchema,
  probeResult: probeResultSchema,
  probeList: probeListSchema,
  settings: settingsSchema,
  requestLog: requestLogSchema,
  logPage: logPageSchema,
  overview: overviewSchema,
  galleryItem: galleryItemSchema,
  galleryPage: galleryPageSchema,
  backfillStatus: backfillStatusSchema,
  storageUninitialized: storageStatusSchema,
  storageLocal: storageStatusSchema,
  storageImgbed: storageStatusSchema,
} as const;
