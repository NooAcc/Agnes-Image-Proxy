# Agnes Image Reverse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Deno Deploy 上提供一个 OpenAI Images API 兼容层，把 `/v1/images/generations` 与 `/v1/images/edits` 翻译成 Agnes `/v1/images/generations`，带多 Key 账号池、请求日志、用量统计、图片时间线和五板块控制台。

**Architecture:** 纯 Web 标准 TypeScript，`main.ts` 只负责读环境变量与装配。协议层把 OpenAI 请求解析成 `ParsedImageRequest`，再由 `agnesPayload()` 生成 Agnes JSON；账号池用 Turso 的原子 `UPDATE … RETURNING` 领取 Key；成功响应的输出图由 `archive.ts` 写成 `gallery` 表的 BLOB，控制台通过同源内容端点读取。

**Tech Stack:** Deno 2.x（无构建步骤）、`@libsql/client/web`（Turso）、`@std/assert`、`@std/encoding/base64`、测试期 `node:sqlite`、原生 HTML/CSS/JS。

**Spec:** `docs/superpowers/specs/2026-11-20-agnes-image-proxy-design.md`

## Global Constraints

- 运行时依赖只有 `@libsql/client/web`；`node:sqlite` 只允许出现在 `lib/testing/` 与 `scripts/`，`main.ts` 的依赖图不得经过它。
- 数据面只认 `Authorization: Bearer <PROXY_API_KEY>`；管理面只认会话 Cookie 或同一 Bearer。
- 缺少 `PROXY_API_KEY`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` 时进程拒绝启动。
- 默认输出 `b64_json`；`n` 只要求正整数、无 1–10 上限，并发数 = `n`；不按分辨率、输出体积或并发做代理侧拒绝；部分成功返回 200。
- Agnes 基础地址默认 `https://apihub.agnes-ai.com/v1`；上游超时默认 300 秒，可设 60–360 秒。
- 请求体上限 32 MiB，单张输入图 20 MiB，最多 16 张；归档下载上限 64 MiB、60 秒。
- 模型名原样透传，不做映射；2.0 用 `exact` 尺寸模式，2.1/2.5 用 `tier`。
- 控制台简体中文、亮色、系统字体、内联 SVG、无外部资源；CSP `default-src 'none'`，`img-src 'self' data:`。
- 测试必须完全离线；`deno task smoke` 才允许真实 Agnes 流量。

## Review Focus

1. **OpenAI SDK 的 multipart 形状**：`client.images.edit(image=file)` 发送 `image`，多图可能是 `image[]`；漏掉任一种都会让最常见的客户端 400。
2. **`size=auto` + URL 参考图**：不能为了推比例去抓取 URL；必须退回 `1K + 1:1` 并加警告，否则引入 SSRF 与超时。
3. **请求了 Base64、上游却回 URL**：客户端响应必须原样保留 URL 并加警告；归档另走一次安全下载，不能把响应路径变成高内存转码。
4. **大图写库失败**：Turso 单行/请求体积限制可能拒绝 BLOB；必须退化为 `archived=0` + `source_url`，客户端响应不受影响。
5. **`extra_body` 字段放置矛盾**：默认嵌套，编辑请求 400 时自动改用顶层 `image` 重发一次；成功后缓存模式，避免重复的双倍请求。
6. **部分成功**：`n` 个子请求里既有成功也有失败时，不能整单报错，也不能把失败伪装成成功；必须返回成功图 + `X-Agnes-Succeeded/Failed` 计数，并让日志的 `requested/images/failed/ok` 一致。

---

### Task 1: 项目骨架与基础设施

**Files:**
- Create: `deno.json`, `.gitignore`
- Create: `lib/limits.ts`, `lib/errors.ts`, `lib/sql.ts`, `lib/http.ts`, `lib/auth.ts`, `lib/config.ts`
- Create: `lib/testing/node-sqlite-executor.ts`
- Test: `tests/lib/errors_test.ts`, `tests/lib/sql_test.ts`, `tests/lib/auth_test.ts`, `tests/lib/config_test.ts`, `tests/lib/http_test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SqlArg = string | number | null | Uint8Array`
  - `SqlExecutor { execute(sql, args?): Promise<SqlResult>; batch?(statements): Promise<SqlResult[]> }`
  - `SqlResult { rows: Record<string, unknown>[]; rowsAffected: number }`
  - `createSqlExecutor({ url, authToken }): SqlExecutor`, `normalizeDatabaseUrl(url): string`, `executeBatch(sql, statements)`, `bytesFromRow(value): Uint8Array | null`
  - `ApiError(status, message, type?, param?, code?, headers?)`, `errorResponseBody(error)`
  - `jsonResponse`, `readJsonBody`, `normalizePath`, `methodNotAllowed`, `errorResponse`, `htmlResponse`, `bytesResponse`, `addWarnings`, `asObject`
  - `timingSafeEqual`, `readCookie`, `createSessionSigner(apiKey, ttlMs?)`
  - `loadConfig(getEnv): Config`
  - `createNodeSqliteExecutor(): SqlExecutor & { close(): void }`

- [ ] **Step 1: 初始化仓库与 Deno 配置**

Create `.gitignore` (`Worker-AI-Reverse/`, `test-key.txt`, `.probe/`, `.deno/`, `*.log`) and `deno.json`:

```json
{
  "tasks": {
    "test": "deno test --allow-env",
    "lint": "deno lint",
    "fmt": "deno fmt",
    "fmt:check": "deno fmt --check",
    "check": "deno check main.ts lib/**/*.ts web/**/*.ts scripts/*.ts tests/**/*.ts",
    "start": "deno run --allow-env --allow-net main.ts",
    "preview": "deno run --allow-net --allow-env scripts/preview.ts",
    "smoke": "deno run --allow-env --allow-net scripts/smoke.ts"
  },
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.13",
    "@std/encoding/base64": "jsr:@std/encoding@^1.0.7/base64",
    "@libsql/client/web": "npm:@libsql/client@0.15.15/web"
  },
  "fmt": { "lineWidth": 100 }
}
```

Run: `git init && git add -A && git commit -m "chore: scaffold deno project"`

- [ ] **Step 2: 写失败的 SQL BLOB 测试**

`tests/lib/sql_test.ts`:

```ts
Deno.test("node sqlite executor round-trips a BLOB", async () => {
  const sql = createNodeSqliteExecutor();
  await sql.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB)");
  const bytes = new Uint8Array([0, 1, 2, 255]);
  await sql.execute("INSERT INTO t (b) VALUES (?)", [bytes]);
  const row = (await sql.execute("SELECT b FROM t")).rows[0];
  assertEquals(bytesFromRow(row.b), bytes);
  sql.close();
});
Deno.test("normalizeDatabaseUrl maps libsql to https", () => {
  assertEquals(normalizeDatabaseUrl("libsql://example.turso.io"), "https://example.turso.io");
});
```

Run: `deno test --allow-env tests/lib/sql_test.ts` — expected FAIL（模块不存在）。

- [ ] **Step 3: 实现 `lib/sql.ts` 与测试执行器**

`bytesFromRow` 接受 `Uint8Array`、`ArrayBuffer`、`number[]`，其余返回 `null`。`createSqlExecutor` 的 `batch` 走 `client.batch(…, "write")`。

Run: `deno test --allow-env tests/lib/sql_test.ts` — expected PASS。

- [ ] **Step 4: 写失败的错误信封与 HTTP 测试**

```ts
Deno.test("ApiError renders the OpenAI nested envelope", () => {
  const body = errorResponseBody(new ApiError(400, "bad mask", "invalid_request_error", "mask", "unsupported_parameter"));
  assertEquals(body, { error: { message: "bad mask", type: "invalid_request_error", param: "mask", code: "unsupported_parameter" } });
});
Deno.test("readJsonBody rejects a declared oversized body", async () => {
  const request = new Request("https://x/", { method: "POST", headers: { "content-length": String(MAX_REQUEST_BYTES + 1) } });
  await assertRejects(() => readJsonBody(request), ApiError);
});
```

Run: expected FAIL。

- [ ] **Step 5: 实现 `lib/limits.ts`、`lib/errors.ts`、`lib/http.ts`**

常量必须与 Global Constraints 一致（32 MiB、20 MiB、16 张、`n` 只校验正整数、300 s、60–360 s、64 MiB、60 s、日志 500、gallery 页 24/100）。`errorResponse` 把非 `ApiError` 统一成 500 `server_error`，并在控制台 `console.error`。

Run: expected PASS。

- [ ] **Step 6: 写失败的鉴权测试**

```ts
Deno.test("session signer accepts its own token and rejects tampering", async () => {
  const signer = createSessionSigner("secret");
  const token = await signer.issue(new Date("2026-01-01T00:00:00Z"));
  assert(await signer.verify(token, new Date("2026-01-02T00:00:00Z")));
  assertFalse(await signer.verify(token + "x", new Date("2026-01-02T00:00:00Z")));
});
Deno.test("timingSafeEqual does not leak length", () => {
  assertFalse(timingSafeEqual("short", "a-much-longer-secret"));
  assert(timingSafeEqual("same", "same"));
});
```

Run: expected FAIL，then implement `lib/auth.ts`（HMAC keyed by `agnes-session:${apiKey}`），expected PASS。

- [ ] **Step 7: 写失败的配置测试**

```ts
Deno.test("loadConfig refuses to boot without the three required variables", () => {
  assertThrows(() => loadConfig(() => undefined), Error);
});
Deno.test("loadConfig parses CORS origins and port", () => {
  const config = loadConfig((key) => ({ PROXY_API_KEY: "k", TURSO_DATABASE_URL: "libsql://x", TURSO_AUTH_TOKEN: "t", PORT: "9000", CORS_ALLOWED_ORIGINS: "https://a.example" })[key]);
  assertEquals(config.port, 9000);
  assertEquals(config.corsAllowedOrigins, ["https://a.example"]);
});
```

Implement `lib/config.ts`（`PORT` 1–65535，CORS 只接受 `http(s)://host[:port]`）。

- [ ] **Step 8: 运行全套并提交**

Run: `deno task fmt && deno task lint && deno task check && deno task test`
Expected: all pass.

```bash
git add -A && git commit -m "feat: add config, sql, auth and http foundations"
```

---

### Task 2: 模型目录与尺寸翻译

**Files:**
- Create: `lib/model-catalog.ts`, `lib/size.ts`
- Test: `tests/lib/size_test.ts`, `tests/lib/model-catalog_test.ts`

**Interfaces:**
- Consumes: `ApiError` from Task 1.
- Produces:
  - `SIZE_TIERS`, `RATIOS`, `SizeTier`, `Ratio`, `PixelSize`, `ResolvedSize`
  - `resolveSize({ size?, ratio?, reference? }): ResolvedSize`
  - `formatPixel(size): string`, `isSizeTier(v)`, `isRatio(v)`
  - `IMAGE_MODELS`, `sizeModeFor(model): "tier" | "exact"`, `imageModelList()`

- [ ] **Step 1: 写失败的尺寸表驱动测试**

```ts
const cases = [
  [{ size: "1024x1024" }, { tier: "1K", ratio: "1:1", pixel: { width: 1024, height: 1024 } }],
  [{ size: "1536x1024" }, { tier: "1K", ratio: "3:2", pixel: { width: 1248, height: 832 } }],
  [{ size: "1792x1024" }, { tier: "1K", ratio: "16:9", pixel: { width: 1312, height: 736 } }],
  [{ size: "2560x1440" }, { tier: "2K", ratio: "16:9", pixel: { width: 2624, height: 1472 } }],
  [{ size: "4096x4096" }, { tier: "4K", ratio: "1:1", pixel: { width: 4096, height: 4096 } }],
  [{ size: "4K", ratio: "21:9" }, { tier: "4K", ratio: "21:9", pixel: { width: 6272, height: 2688 } }],
  [{ size: "auto", reference: { width: 900, height: 1200 } }, { tier: "1K", ratio: "3:4", pixel: { width: 864, height: 1152 } }],
];
for (const [input, expected] of cases) {
  Deno.test(`resolveSize ${JSON.stringify(input)}`, () => assertEquals(resolveSize(input), expected));
}
Deno.test("resolveSize rejects an unknown ratio", () => assertThrows(() => resolveSize({ size: "1K", ratio: "7:5" }), ApiError));
```

Run: expected FAIL。

- [ ] **Step 2: 实现 `lib/size.ts`**

使用设计文档的 8×4 原生尺寸表；档位按 1K≈1.05MP、2K≈4.19MP、3K≈9.44MP、4K≈16.78MP 的对数距离取最近；比例按对数距离取最近；显式 `ratio` 覆盖推算值；`size` 为档位时直接使用。`resolveSize` 对显式非法值抛 `ApiError(400, …, "invalid_request_error", "ratio"|"size")`。

Run: `deno test --allow-env tests/lib/size_test.ts` — PASS。

- [ ] **Step 3: 写失败的模型目录测试**

```ts
Deno.test("catalog exposes three image models and 2.0 is exact", () => {
  assertEquals(imageModelList().map((m) => m.id), [
    "agnes-image-2.5-flash", "agnes-image-2.1-flash", "agnes-image-2.0-flash",
  ]);
  assertEquals(sizeModeFor("agnes-image-2.0-flash"), "exact");
  assertEquals(sizeModeFor("agnes-image-2.5-flash"), "tier");
  assertEquals(sizeModeFor("unknown-model"), "tier");
});
```

Run: FAIL，implement `lib/model-catalog.ts`，PASS。

- [ ] **Step 4: 提交**

```bash
deno task fmt && deno task lint && deno task test
git add -A && git commit -m "feat: add image model catalog and size translation"
```

---

### Task 3: 图片尺寸解析

**Files:**
- Create: `lib/image-dimensions.ts`
- Test: `tests/lib/image-dimensions_test.ts`

**Interfaces:**
- Produces: `readImageDimensions(bytes: Uint8Array): { width: number; height: number } | null`

- [ ] **Step 1: 写失败测试（PNG / JPEG / WebP / 垃圾数据）**

构造最小头字节：PNG 签名 + 4 字节长度 + `IHDR` + `00 00 00 02 00 00 00 03`，断言 `{ width: 2, height: 3 }`；JPEG 用 `FF D8 FF C0 00 11 08 00 03 00 02 …`，断言 `{ width: 2, height: 3 }`；WebP 用 `RIFF????WEBPVP8X` + 24 位宽高，断言对应值；`new Uint8Array([1,2,3])` 返回 `null`。

Run: expected FAIL。

- [ ] **Step 2: 实现 `lib/image-dimensions.ts`**

只读文件头，不依赖任何解码库；PNG 大端读 16/20 字节，JPEG 扫描 SOF0–SOF3/SOF5–SOF7/SOF9–SOF11/SOF13–SOF15，WebP 支持 `VP8X`、`VP8 `、`VP8L`。任何越界返回 `null`。

Run: PASS。

- [ ] **Step 3: 提交**

```bash
deno task fmt && deno task lint && deno task test
git add -A && git commit -m "feat: read PNG JPEG and WebP dimensions from headers"
```

---

### Task 4: 设置存储

**Files:**
- Create: `lib/settings.ts`
- Test: `tests/lib/settings_test.ts`

**Interfaces:**
- Consumes: `SqlExecutor`, `executeBatch`, `ApiError`, `imageModelList`.
- Produces:
  - `AppSettings { agnesBaseUrl; defaultResponseFormat: "b64_json"|"url"; defaultSize: SizeTier; defaultRatio: Ratio; imageParamMode: "auto"|"nested"|"top_level"; probeModel; probeConcurrency; requestTimeoutMs; maxAttempts }`
  - `DEFAULT_SETTINGS`, `SettingsStore { read(); write(next) }`, `createSettingsStore(sql)`, `createCachedSettings(store, ttlMs?, now?)`, `validateSettings(next)`

- [ ] **Step 1: 写失败测试**

测试前先执行 `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`（Task 5 的 `ensureSchema` 会创建同一张表）。断言默认值（`https://apihub.agnes-ai.com/v1`、`b64_json`、`1K`、`1:1`、`auto`、`agnes-image-2.5-flash`、并发 2、超时 300000、尝试 3）；写后读回；拒绝非 https 的基础地址（localhost 例外）；拒绝 `probeConcurrency` 0/11；拒绝超时 59999/360001；缓存写入后立即生效。

Run: FAIL。

- [ ] **Step 2: 实现 `lib/settings.ts`**

`settings` 表是 key/value；写入用 `executeBatch` 的 upsert；缓存 TTL 默认 10 秒，`write` 同时刷新缓存。

Run: PASS。

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "feat: add database-backed settings"
```

---

### Task 5: 账号存储与账号池

**Files:**
- Create: `lib/accounts.ts`, `lib/pool.ts`
- Test: `tests/lib/accounts_test.ts`, `tests/lib/pool_test.ts`

**Interfaces:**
- Consumes: `SqlExecutor`, `bytesFromRow`, `ApiError`, limits, `AgnesClient`.
- Produces:
  - `ensureSchema(sql)`（accounts、request_log、model_usage_daily、gallery、settings 全部 DDL）
  - `AccountStore { list; get; create; update; remove; claim; resetHealth; markHealthy; recordSuccess; addImages; recordFailure }`
  - `ClaimedAccount { id; name; apiKey; seq; consecutiveFailures }`, `maskKey(key)`
  - `AccountPool { gateway(baseUrl, hooks?, options?): AgnesGateway }`, `classifyFailure(error)`, `ServedBy { id; name }`
  - `GatewayOptions { timeoutMs?: number; maxAttempts?: number }`
  - `AgnesClientFactory = (credentials: { baseUrl; apiKey; timeoutMs? }) => AgnesClient`

- [ ] **Step 1: 写失败的表结构与 CRUD 测试**

用 `createNodeSqliteExecutor()` 建库；创建账号后 `list()` 返回掩码后的 Key；重名抛 409；`claim` 两次返回不同账号；`recordFailure` 后冷却中的账号不再被领取；`addImages` 累加。

Run: FAIL。

- [ ] **Step 2: 实现 `lib/accounts.ts`**

`claim` 使用设计中的原子 SQL：

```sql
UPDATE accounts SET last_used_at = ?
WHERE id = (SELECT id FROM accounts
            WHERE enabled = 1 AND (cooldown_until IS NULL OR cooldown_until <= ?)
              AND id NOT IN (…)
            ORDER BY (last_used_at IS NOT NULL), last_used_at, seq LIMIT 1)
RETURNING id, name, api_key, seq, consecutive_failures
```

`maskKey` 输出 `前 4 位…后 4 位`；Key 明文只出现在 `ClaimedAccount.apiKey` 与数据库。

Run: PASS。

- [ ] **Step 3: 写失败的池子测试**

用 fake `AgnesClientFactory`：
- 两个账号、4 次成功 → 领取顺序 A、B、A、B。
- A 抛 401、B 成功 → 结果来自 B，A 的 `health.state` 变 `degraded` 且 `cooldown_until > now`。
- A 抛 429 带 `retry-after: 120` → A 冷却约 120 秒；B 被使用。
- A 抛 400 → 不重试、不换号、直接抛出。
- 三个账号都 500 → 抛 503，消息含尝试次数。

Run: FAIL。

- [ ] **Step 4: 实现 `lib/pool.ts`**

`classifyFailure`：401/403 → 15 分钟；429 → `retry-after` 否则 60 秒；400/404 → 非账号问题；其余 → 60 秒起指数退避，最长 15 分钟。每次请求最多 `options.maxAttempts`（默认 3）个账号，`options.timeoutMs` 传给 `createClient`；成功写 `recordSuccess`；失败写 `recordFailure`，bookkeeping 失败不得改变结果。

Run: PASS。

- [ ] **Step 5: 提交**

```bash
deno task fmt && deno task lint && deno task test
git add -A && git commit -m "feat: add account store and rotating account pool"
```

---

### Task 6: Agnes 上游客户端

**Files:**
- Create: `lib/agnes.ts`
- Test: `tests/lib/agnes_test.ts`

**Interfaces:**
- Consumes: `ApiError`, limits.
- Produces:
  - `AgnesRequest { path: string; body: unknown }`, `AgnesResult { status: number; body: unknown }`
  - `AgnesClient { generate(request, signal?): Promise<AgnesResult> }`
  - `createAgnesClient({ baseUrl, apiKey, timeoutMs?, fetchImpl? }): AgnesClient`
  - `upstreamMessage(body, status): string`

- [ ] **Step 1: 写失败测试**

Fake fetch 断言：URL 是 `${baseUrl}/images/generations`；带 `Authorization: Bearer key` 与 JSON content-type；200 原样返回 body；429 抛 `ApiError` 且 `headers.get("retry-after")` 保留；401 抛 `status 401`；500 抛 `status 502` 且消息含上游 message；Abort 抛 504；上游 400 的 `{"error":{"message":"n must be 1","type":"invalid_request","code":"invalid_request"}}` 让 `ApiError.message` 等于 `n must be 1`。

Run: FAIL。

- [ ] **Step 2: 实现 `lib/agnes.ts`**

用 `AbortSignal.timeout(timeoutMs)`；`response.json()` 失败时用文本兜底；非 2xx 统一抛 `ApiError`（429 保留 429，401/403 保留原状态，其余 5xx 映射为 502，超时 504），并把 `retry-after` 放进错误 headers。

Run: PASS。

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "feat: add Agnes upstream client"
```

---

### Task 7: 协议层 — 文生图 JSON

**Files:**
- Create: `lib/protocol.ts`
- Test: `tests/lib/protocol_generations_test.ts`

**Interfaces:**
- Consumes: `resolveSize`, `sizeModeFor`, `ApiError`, `readImageDimensions`, settings defaults passed as arguments.
- Produces:
  - `ImageEndpoint = "generations" | "edits"`
  - `ParsedImageRequest { endpoint; model; prompt; n; size: ResolvedSize; responseFormat; images: string[]; warnings: string[]; extraBody: Record<string, unknown> }`
  - `parseImageRequestJson(raw, endpoint, defaults): ParsedImageRequest`
  - `agnesPayload(request, mode: "nested" | "top_level"): { path: string; body: Record<string, unknown> }`
  - `normalizeAgnesResponse(raw, request): { body; images: NormalizedImage[]; warnings: string[] }`
  - `mergeNormalizedResponses(responses)`
  - `NormalizedImage { url: string|null; b64_json: string|null }`

- [ ] **Step 1: 写失败的解析测试**

断言：
- 最小 `{ model, prompt, size: "1024x1024" }` → `n=1`、`size.tier="1K"`、`responseFormat="b64_json"`。
- `response_format: "url"` → `url`；`return_base64: false` → `url`；`return_base64: true` → `b64_json`。
- `n: 0` / `n: 1.5` / `n: "3"` → 400；`n: 5` 与 `n: 25` 通过（没有 10 的上限）。
- `quality`、`background`、`output_format`、未知字段 → 进入 `warnings`，请求仍成功。
- `extra_body: { foo: 1 }` → `extraBody.foo === 1`。
- `model` / `prompt` 缺失或空 → 400。

Run: FAIL。

- [ ] **Step 2: 实现解析与 payload 构造**

Payload 规则：
- `tier` 模型：`{ model, prompt, size: "1K", ratio: "1:1" }`；`exact` 模型：`{ model, prompt, size: "1024x1024" }`。
- 无参考图且 `b64_json`：顶层 `return_base64: true`。
- 有参考图：`extra_body.image = images`（或顶层 `image`），`extra_body.response_format` 为 `"b64_json"|"url"`。
- 无参考图且 `url`：`extra_body.response_format = "url"`。
- `extraBody` 的其他键原样合并，已消费的键不重复。

Run: PASS。

- [ ] **Step 3: 写失败的响应规范化测试**

- `{ created: 1, data: [{ url: "https://x/a.png", b64_json: "", revised_prompt: "" }] }` → `data[0]` 三项齐全、`url` 保留、`b64_json` 为 `null`、`revised_prompt` 为 `null`。
- 请求 b64 但只回 URL → `warnings` 含 `upstream-returned-url`。
- `data` 缺失 → 502。
- 两个响应合并后 `data` 长度为 2。

Run: FAIL。

- [ ] **Step 4: 实现 `normalizeAgnesResponse` 与 `mergeNormalizedResponses`**

校验上游 `data` 是数组，逐项输出 `{ url: d.url || null, b64_json: d.b64_json || null, revised_prompt: null }`（实测上游用空字符串表示未使用字段，必须转成 `null`）；响应体补 `size: formatPixel(request.size.pixel)` 与 `output_format: "png"`；请求 b64 但没有任何 `b64_json` 时追加 `upstream-returned-url` 警告；合并时拼接 `data` 并去重 warnings。

Run: PASS。

- [ ] **Step 5: 提交**

```bash
deno task fmt && deno task lint && deno task test
git add -A && git commit -m "feat: translate OpenAI image generation requests to Agnes"
```

---

### Task 8: 协议层 — 参考图与 multipart

**Files:**
- Modify: `lib/protocol.ts`
- Test: `tests/lib/protocol_edits_test.ts`

**Interfaces:**
- Produces: `parseImageRequestMultipart(request, defaults): Promise<ParsedImageRequest>`

- [ ] **Step 1: 写失败的 multipart 测试**

用 `FormData` 构造 `Request`：
- 单个 `image` 与 `image[]` 两种键都能解析成 `images[1]`。
- 两个文件 → `images[2]`，顺序保持。
- `mask` → 400 `unsupported_parameter`。
- 非 `image/png|jpeg|webp` → 400。
- 一个 `new Uint8Array(MAX_INPUT_IMAGE_BYTES + 1)` 的 File → 400。
- 多个文件总字节超过 `MAX_REQUEST_BYTES` → 413（先检查 `Content-Length`，解析后累计再检查一次）。
- `size=auto` + 一个 2×3 PNG → `1K/2:3`（比例来自文件头）。
- `size=auto` + 只有 URL 参考图 → `1K/1:1` 且 warnings 含 `auto-size-from-url`。

Run: FAIL。

- [ ] **Step 2: 实现 multipart 解析**

`request.formData()`；接受 `image`、`image[]`、`images`；File 读 `arrayBuffer()`，校验 MIME 与大小，转成 `data:<mime>;base64,<...>`；在转换前读取尺寸供 `auto` 使用；`mask`/`file_id` 直接 400；解析后累计所有文件字节，超过 `MAX_REQUEST_BYTES` 返回 413。

Run: PASS。

- [ ] **Step 3: 写失败的 JSON edits 测试**

- `images: [{ image_url: "https://x/a.png" }, { image_url: "data:image/png;base64,…" }]` → `images` 两个。
- `{ file_id: "file-1" }` → 400。
- `extra_body.image` 字符串数组 → 通过。
- 顶层 `image` 单字符串 → `images[1]`。

Run: FAIL。

- [ ] **Step 4: 实现 JSON edits 形状**

`images` 数组逐项只接受 `{ image_url: string }`；`image_url` 必须是 http(s) 或 data URI；`file_id` 出现即 400；`extra_body.image` 与顶层 `image` 统一归一化为 `images`。

Run: PASS。

- [ ] **Step 5: 写失败的 payload 放置测试**

- `nested` 模式：`extra_body.image` 存在，顶层无 `image`。
- `top_level` 模式：顶层 `image` 存在，`extra_body.image` 不存在。
- 两者的 `response_format` 都在 `extra_body`。

Run: PASS。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: accept multipart and JSON image edits"
```

---

### Task 9: 请求日志与模型用量

**Files:**
- Create: `lib/logs.ts`, `lib/model-usage.ts`
- Test: `tests/lib/logs_test.ts`, `tests/lib/model-usage_test.ts`

**Interfaces:**
- Produces:
  - `RequestLogInput { ts; endpoint; path; model; accountId; accountName; status; ok; durationMs; requested; images; failed; size; error; attempts }`
  - `RequestLogStore { record; list(limit?); count; clear }`
  - `ModelUsageStore { record({ model; endpoint; day; ok; images; at }); byDay(day): Promise<Map<string, ModelUsageRow>> }`
  - `ModelUsageRow { requests; errors; images; lastUsedAt }`

- [ ] **Step 1: 写失败测试**

用 `createNodeSqliteExecutor()` + `ensureSchema(sql)` 建库。

- 插入 505 条日志后 `count() === 500`，最新一条在最前。
- 日志包含 `attempts` JSON 往返，`requested`/`images`/`failed` 原样读回。
- `byDay` 对同一模型累加 requests/errors/images，并更新 `lastUsedAt`。
- 当天没有记录的模型不出现在 map 里（控制台负责补 0）。

Run: FAIL。

- [ ] **Step 2: 实现 `lib/logs.ts` 与 `lib/model-usage.ts`**

日志插入与裁剪同一条 batch；表结构含 `requested`、`images`、`failed` 三列；`attempts` 用 JSON 字符串；用量 upsert 用 `ON CONFLICT (model, day)` 累加 `requests`/`errors`/`images`。

Run: PASS。

- [ ] **Step 3: 提交**

```bash
git add -A && git commit -m "feat: add request logs and per-model daily usage"
```

---

### Task 10: 图片归档存储

**Files:**
- Create: `lib/gallery.ts`
- Test: `tests/lib/gallery_test.ts`

**Interfaces:**
- Consumes: `SqlExecutor`, `bytesFromRow`, limits.
- Produces:
  - `GalleryInsert { ts; endpoint; model; accountId; accountName; prompt; size; tier; ratio; mime; bytes: Uint8Array|null; sourceUrl: string|null }`
  - `GalleryItem`（无 `bytes`）、`GalleryPage { items; nextBefore: number|null }`
  - `GalleryStore { record(input): Promise<number>; list(before, limit): Promise<GalleryPage>; content(id): Promise<{ mime; bytes } | null>; remove(id): Promise<boolean>; clear(): Promise<void>; count(): Promise<number> }`
  - `createGalleryStore(sql)`

- [ ] **Step 1: 写失败的 BLOB 往返测试**

用 `createNodeSqliteExecutor()` + `ensureSchema(sql)` 建库。插入带 `bytes` 的一行 → `record` 返回 id；`content(id)` 返回同样的 `Uint8Array` 与 MIME；`archived` 为 true；插入 `bytes: null, sourceUrl: "https://…"` 的一行 → `archived` 为 false，`content` 返回 `null`。

Run: FAIL。

- [ ] **Step 2: 实现 `lib/gallery.ts`**

`list` 按 `id DESC`，`before` 用 `WHERE id < ?`，取 `limit + 1` 判断是否还有下一页；`nextBefore` 是本页最后一条 id（没有更多时为 `null`）。列表 SQL 不选 `bytes`。`remove`/`clear` 返回/清理影响行数。

Run: PASS。

- [ ] **Step 3: 写失败的分页与删除测试**

插入 30 行，`list(null, 24)` 返回 24 条且 `nextBefore` 非空；用该游标取下一页返回 6 条且 `nextBefore` 为 `null`；删除一条后 `count()` 减一；`clear()` 后为 0。

Run: PASS。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: store archived images as BLOBs with pagination"
```

---

### Task 11: 归档流程与安全下载

**Files:**
- Create: `lib/archive.ts`
- Test: `tests/lib/archive_test.ts`

**Interfaces:**
- Consumes: `GalleryStore`, `NormalizedImage`, `decodeBase64`, limits.
- Produces:
  - `ArchiveRequest { ts; endpoint; model; accountId; accountName; prompt; size; tier; ratio; images: NormalizedImage[] }`
  - `Archiver { archive(request): Promise<void> }`
  - `createArchiver({ gallery, fetchImpl?, waitUntil?, maxBytes?, timeoutMs? }): Archiver`
  - `isPublicHttpsUrl(value): boolean`, `sniffImageMime(bytes): string|null`

- [ ] **Step 1: 写失败的 Base64 归档测试**

用 fake gallery store；`b64_json` 为 1×1 PNG 的 Base64 → 写入 `bytes`、`mime="image/png"`、`archived=true`；`b64_json` 非法 → 写入 `bytes:null`、`sourceUrl:null`、不抛错。

Run: FAIL。

- [ ] **Step 2: 实现 Base64 路径与 MIME 嗅探**

`decodeBase64` 来自 `@std/encoding/base64`；`sniffImageMime` 识别 PNG/JPEG/WebP 魔数；识别失败时用上游 URL 的扩展名或 `image/png`。

Run: PASS。

- [ ] **Step 3: 写失败的 URL 下载与 SSRF 测试**

Fake fetch：
- `https://platform-outputs.agnes-ai.space/images/t2i/task_x/output.png` 返回 PNG 字节与 `content-type: image/png` → 写入 bytes（主机不写死，换一个 https 主机同样通过）。
- `http://…`、`https://127.0.0.1/…`、`https://10.0.0.5/…`、`https://[::1]/…` → 不 fetch，写入 `archived=false`。
- 返回 `text/html` 且内容非图片 → `archived=false`。
- `content-length` 超过 64 MiB → `archived=false`。
- 重定向到私网 → `archived=false`。
- 下载抛错 → `archived=false`，`source_url` 保留。

Run: FAIL。

- [ ] **Step 4: 实现安全下载**

`redirect: "manual"`，最多跟随 2 次，每次校验目标；流式读 body 并累计字节，超限中止；超时用 `AbortSignal.timeout(60_000)`；`waitUntil` 默认取 `globalThis.EdgeRuntime?.waitUntil`，没有就返回任务 Promise。

Run: PASS。

- [ ] **Step 5: 写失败的写库失败回退测试**

Fake gallery store 第一次 `record` 抛错，第二次成功；断言第二次收到 `bytes:null` 且 `sourceUrl` 保留，`archive()` 不抛错。

Run: PASS。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: archive generated images with guarded downloads"
```

---

### Task 12: 数据面路由与 `n` 扇出

**Files:**
- Create: `lib/app.ts`
- Test: `tests/lib/app_test.ts`

**Interfaces:**
- Consumes: Tasks 5–11；`HandlerOptions`。
- Produces:
  - `AdminRouter { matches(path: string): boolean; handle(request, path): Promise<Response> }`（`AdminApi` 结构上满足它，避免提前依赖 Task 13）
  - `HandlerOptions { pool; store: AccountStore; settings; admin: AdminRouter; logs; modelUsage; archiver; apiKey; session; renderAdminPage?; renderLoginPage?; corsAllowedOrigins?; readyCheck?; now? }`
  - `createHandler(options): (request: Request) => Promise<Response>`

- [ ] **Step 1: 写失败的鉴权与路由测试**

- 无 Bearer 的 `/v1/images/generations` → 401 嵌套错误信封。
- 错误 Bearer → 401；Cookie 不生效。
- `GET /v1/models` 返回三个模型。
- `POST /v1/images/edit` 与 `/edits` 都路由到编辑处理。
- `/health` 200；`/` 302 到 `/admin`；未知路径 404。
- `stream: true` → 400 `unsupported_parameter`，`param="stream"`。

Run: FAIL。

- [ ] **Step 2: 实现路由与鉴权**

数据面只认 Bearer；管理面 Cookie 或 Bearer；CSP 允许 `img-src 'self' data:`；CORS 只作用于数据面。

Run: PASS。

- [ ] **Step 3: 写失败的文生图端到端测试**

Fake pool gateway 返回 `{ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }`；POST `{ model: "agnes-image-2.5-flash", prompt: "x", size: "1024x1024" }`：
- 200，`data[0].b64_json` 保留，`size === "1024x1024"`，`output_format === "png"`。
- 上游收到 `size:"1K", ratio:"1:1", return_base64:true`。
- `X-Agnes-Resolved-Size: 1K 1:1`。
- `logs.record` 收到 `requested=1`、`images=1`、`failed=0`、`ok=true`；`store.addImages(accountId, 1)` 被调用。
- 池子收到的 `GatewayOptions` 含设置里的 `timeoutMs` 与 `maxAttempts`。

Run: FAIL。

- [ ] **Step 4: 实现数据面主流程**

`parse → settings → resolveSize → n 次并发 runOnce → allSettled → normalize → merge 成功项`；每个子请求通过 `pool.gateway(baseUrl, hooks, { timeoutMs, maxAttempts })` 领取账号，成功后调用 `store.addImages(accountId, images.length)`，再 `archiver.archive(...)`。成功数 ≥1 时返回 200，`data` 只含成功图并保持原索引顺序，响应头写 `X-Agnes-Requested/Succeeded/Failed`、`X-Agnes-Failure-Statuses` 与 `partial-success`；全部失败时抛第一个子请求的错误。日志写 `requested/images(成功数)/failed`，`ok = failed === 0`。

Run: PASS。

- [ ] **Step 5: 写失败的 `n` 扇出与警告测试**

- `n: 25` → gateway 被调用 25 次，`data.length === 25`；没有 10 的上限。
- `quality` + `background` → 200，`X-Agnes-Warnings` 包含两者。
- `n: 5` 中 2 次失败 → 200，`data.length === 3`，`X-Agnes-Succeeded: 3`、`X-Agnes-Failed: 2`、
  `X-Agnes-Failure-Statuses` 含失败状态码、`X-Agnes-Warnings` 含 `partial-success`；日志
  `requested=5`、`images=3`、`failed=2`、`ok=false`；归档只收到 3 张图。
- `n: 5` 全部失败 → 返回第一个错误的状态与信封；日志 `requested=5`、`images=0`、`failed=5`、`ok=false`。

Run: PASS。

- [ ] **Step 6: 写失败的 `image_param_mode` 自动回退测试**

Fake gateway 第一次抛 400，第二次成功：断言第二次 payload 顶层有 `image`、`extra_body` 无 `image`；同一进程后续编辑请求第一次就使用顶层（缓存 10 分钟，用注入的 `now` 推进时间后恢复 nested）。

Run: PASS。

- [ ] **Step 7: 归档调度测试**

断言 `archiver.archive` 在每个成功子请求后被调用一次，参数含 prompt/model/size/tier/ratio/账号；归档抛错不影响响应。

Run: PASS。

- [ ] **Step 8: 提交**

```bash
deno task fmt && deno task lint && deno task test
git add -A && git commit -m "feat: serve OpenAI image endpoints with account failover"
```

---

### Task 13: 管理 API — 会话、账号、设置、日志、总览

**Files:**
- Create: `lib/admin.ts`
- Test: `tests/lib/admin_test.ts`

**Interfaces:**
- Consumes: `AccountStore`, `SettingsStore`, `RequestLogStore`, `ModelUsageStore`, `GalleryStore`, `AgnesClientFactory`, session signer.
- Produces:
  - `AdminApi { matches(path): boolean; handle(request, path): Promise<Response> }`
  - `createAdminApi(options): AdminApi`
  - `SESSION_PATH = "/admin/api/session"`, `SESSION_COOKIE = "agnes_session"`, `sessionCookie(token, maxAgeSeconds, secure, now): string`

- [ ] **Step 1: 写失败的会话测试**

用 `createNodeSqliteExecutor()` + `ensureSchema(sql)` 建库。`POST /admin/api/session` 正确 Key → 204 + `Set-Cookie` 含 `HttpOnly`、`SameSite=Lax`、`Path=/admin`、`Max-Age`；错误 Key → 401；`DELETE` 清除 Cookie；无会话访问 `/admin/api/accounts` → 401。

Run: FAIL。

- [ ] **Step 2: 实现会话、登录与路由匹配**

`matches(path)` 覆盖 `/admin/api/session`、账号、设置、日志、总览与 gallery；登录用 `timingSafeEqual` 比较 body 里的 `key` 与 `PROXY_API_KEY`；Cookie 值来自 `session.issue(now)`。

Run: PASS。

- [ ] **Step 3: 写失败的账号 CRUD 与测试接口**

- `POST /admin/api/accounts` `{ name, apiKey }` → 201，响应里 Key 被掩码。
- `PATCH` 改名/启停；`DELETE` 删除。
- `POST /:id/test` 用 fake client 成功 → `health.state="healthy"`；失败 → `degraded` 并返回错误。
- 单个测试的请求体含设置里的 `probeModel`，`size:"1K"`、`ratio:"1:1"`、`response_format:"url"`。
- `POST /admin/api/accounts/test` 按 `settings.probeConcurrency` 并发测试所有启用账号，逐项返回结果。
- `POST /admin/api/accounts/import` 每行 `name,key`，逐行汇报成功/失败。
- 重复名称 → 409。

Run: FAIL。

- [ ] **Step 4: 实现账号管理接口**

CRUD 走 `AccountStore`；测试接口用 `createClient` 直接打上游（不经池子），按结果 `markHealthy` 或 `recordFailure`；导入逐行解析，单行失败不影响其余行；所有响应掩码 Key。

Run: PASS。

- [ ] **Step 5: 写失败的设置、日志、总览测试**

- `GET/PUT /admin/api/settings` 往返；非法值 400。
- `GET /admin/api/logs` 最新 200；`DELETE` 清空。
- `GET /admin/api/overview?day=2026-11-20` 返回 `totals`、`accounts`、`settings`、`models`；模型表包含目录中未使用的模型（0 值）。

Run: FAIL。

- [ ] **Step 6: 实现设置、日志、总览**

总览的模型行 = `IMAGE_MODELS` 合并 `modelUsage.byDay(day)`，缺失值补 0；`day` 必须是 `YYYY-MM-DD`，默认 UTC 今天；`totals` 汇总请求、错误、图片数。

Run: PASS。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -m "feat: add admin API for accounts, settings and logs"
```

---

### Task 14: 管理 API — 图片时间线

**Files:**
- Modify: `lib/admin.ts`
- Test: `tests/lib/admin_gallery_test.ts`

**Interfaces:**
- Consumes: `GalleryStore`.
- Produces: routes `GET /admin/api/gallery`, `GET /admin/api/gallery/:id/content`, `DELETE /admin/api/gallery/:id`, `DELETE /admin/api/gallery`.

- [ ] **Step 1: 写失败的列表与内容测试**

用 `createNodeSqliteExecutor()` + `ensureSchema(sql)` 建库，并插入两条 gallery 记录。

- `GET /admin/api/gallery?limit=2` → 2 条、`nextBefore` 正确、响应不含 `bytes`。
- `limit=0` / `limit=101` → 400。
- `GET /:id/content` 返回入库字节、正确 `content-type`、`cache-control: private, max-age=300`、`nosniff`。
- 不存在的 id → 404。
- 未登录 → 401。

Run: FAIL。

- [ ] **Step 2: 实现列表与内容路由**

正则 `^/admin/api/gallery/(\d+)/content$`；列表参数解析与上限；内容端点用 `bytesResponse`。

Run: PASS。

- [ ] **Step 3: 写失败的删除测试**

`DELETE /:id` 返回 204，之后 404；`DELETE /admin/api/gallery` 清空并返回 204；未登录 401。

Run: PASS。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: serve the gallery API"
```

---

### Task 15: 控制台 — 外壳、总览、账号

**Files:**
- Create: `web/ui.ts`, `web/styles.ts`, `web/icons.ts`, `web/console.ts`, `web/login.ts`
- Test: `tests/web/ui_test.ts`, `tests/web/login_test.ts`

**Interfaces:**
- Produces: `renderAdminPage(): string`, `renderLoginPage(): string`, `BASE_STYLE`, `LOGIN_STYLE`, `ICON_SPRITE`.

- [ ] **Step 1: 写失败的渲染测试**

- `renderAdminPage()` 含 `data-section="overview"`、`"gallery"`、`"accounts"`、`"logs"`、`"settings"`。
- 五个导航项；默认板块是 `overview`。
- 页面不含 `http://` 或 `https://` 的外部资源（字体/脚本/图片）。
- `renderLoginPage()` 含 `PROXY_API_KEY` 提示与登录表单，不含控制台标记。
- CSP 由 `htmlResponse` 设置，测试断言头包含 `default-src 'none'` 与 `img-src 'self' data:`。

Run: FAIL。

- [ ] **Step 2: 实现设计令牌与外壳**

`styles.ts` 定义亮色令牌（背景 `#f4f7f6`、主色 `#047857`、正文 14px、圆角 10px、系统字体栈），侧栏/底部导航、卡片、表格、按钮、弹层、时间线网格与空状态。`web/console.ts` 输出完整文档，内联 JS 用 fragment 切板块。

Run: PASS。

- [ ] **Step 3: 写失败的账号交互脚本断言**

HTML 包含 `data-action="add-account"`、`data-action="import-accounts"`、`data-action="test-all"`、`data-action="reset-account"`；脚本包含 `/admin/api/accounts`、`/admin/api/accounts/import`、`/.test`、`/.reset`。

Run: PASS。

- [ ] **Step 4: 提交**

```bash
deno task fmt && deno task lint && deno task test
git add -A && git commit -m "feat: render the console shell, overview and accounts"
```

---

### Task 16: 控制台 — 日志、设置、图片时间线

**Files:**
- Create: `web/gallery.ts`
- Modify: `web/console.ts`, `web/styles.ts`
- Test: `tests/web/gallery_test.ts`, `tests/web/console_test.ts`

**Interfaces:**
- Produces: `renderGallerySection(): string`、`GALLERY_SCRIPT: string`。

- [ ] **Step 1: 写失败的图片板块测试**

`renderGallerySection()` 含 `data-section="gallery"`、`data-role="gallery-grid"`、`data-action="clear-gallery"`、空状态文案；`GALLERY_SCRIPT` 含 `/admin/api/gallery`、`IntersectionObserver`、`data-action="delete-image"`，且不含外部 URL。

Run: FAIL。

- [ ] **Step 2: 实现时间线**

按 UTC 日期分组；每条卡片含缩略图 `<img loading="lazy" src="/admin/api/gallery/{id}/content">`、时间、模型、尺寸、账号、提示词（截断 + title）；`archived=false` 渲染占位卡与 `sourceUrl` 链接；点击打开 `<dialog>` 大图；删除按钮二次确认；清空全部按钮。

Run: PASS。

- [ ] **Step 3: 写失败的日志与设置测试**

日志板块含 5 秒刷新、“选中文字时暂停”，以及 `succeeded/requested` 与失败状态码的展示；设置表单含 `agnesBaseUrl`、`defaultResponseFormat`、`defaultSize`、`defaultRatio`、`imageParamMode`、`probeModel`、`probeConcurrency`、`requestTimeoutMs`、`maxAttempts`。

Run: PASS。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: add gallery timeline and console settings"
```

---

### Task 17: 装配、预览与烟测

**Files:**
- Create: `main.ts`, `scripts/harness.ts`, `scripts/preview.ts`, `scripts/smoke.ts`
- Test: `tests/app/wiring_test.ts`

**Interfaces:**
- Produces: `buildHarness(options): Promise<Harness>`, `openDatabase(options)`, `main.ts` 可执行入口。

- [ ] **Step 1: 写失败的装配测试**

`buildHarness({ apiKey, sql, createClient: fake, archiver })` 返回可调用的 handler；用 Bearer 调 `/v1/images/generations` 返回 200；`/health?deep=1` 在 SQL 正常时 200、SQL 抛错时 503；`/admin` 无会话返回登录页。

Run: FAIL。

- [ ] **Step 2: 实现 `scripts/harness.ts` 与 `main.ts`**

`main.ts` 读配置、建 schema、装配 store/pool/admin/handler、`Deno.serve`。`harness.ts` 供测试与预览共用，默认 `node:sqlite`，`--turso` 时用真实库。

Run: PASS。

- [ ] **Step 3: 实现预览服务并手工验证**

`scripts/preview.ts`：内存 SQLite、固定密钥 `preview`、种子账号（含一个坏 Key）、20 条日志、6 张 1×1 PNG 的 gallery 记录、`/preview-shot` 自动登录。运行 `deno task preview`，浏览器打开 `http://localhost:8001/admin`，确认五个板块、图片时间线、删除按钮可见。

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8001/health` → `200`。

- [ ] **Step 4: 实现烟测**

`scripts/smoke.ts` 读 `SMOKE_AGNES_API_KEY`，跑：`/v1/models` → 文生图 1K → 用返回图做一次 edits → 检查 `/admin/api/gallery` 至少 2 条 → 删除一条。缺 Key 时打印用法并以 0 退出（可选脚本）。

Run: 有真实 Key 时 `SMOKE_AGNES_API_KEY=… deno task smoke`；无 Key 时跳过。

- [ ] **Step 5: 提交**

```bash
deno task fmt && deno task lint && deno task check && deno task test
git add -A && git commit -m "feat: wire the app and add preview and smoke scripts"
```

---

### Task 18: 文档与最终验证

**Files:**
- Create: `README.md`
- Test: 无新增；运行全套检查。

- [ ] **Step 1: 写 README**

Cover: 项目是什么、两个端点、`openai` SDK 示例（generations + edits）、环境变量、Turso 建库、部署到 Deno Deploy（含 2027 年 4 月关闭说明）、账号池语义（独立账号才叠加额度）、图片时间线与存储成本、`n` 无 10 上限与部分成功语义（`X-Agnes-Requested/Succeeded/Failed`）、超时/体积的已知取舍、`deno task` 列表。

- [ ] **Step 2: 运行最终验证**

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
```

Expected: 四条命令全部通过，测试数 ≥ 60。

- [ ] **Step 3: 用 `test-key.txt` 复验真实行为（不提交 Key）**

已用该 Key 在 2026-11-20 实测并写入设计文档：

1. `extra_body.image` 与顶层 `image`、`extra_body.response_format` 与顶层 `response_format` 都被接受；文档里“顶层会报错”没有复现。
2. 文生图 `return_base64: true` 返回 `b64_json`；图生图 `extra_body.response_format: "b64_json"` 也返回 `b64_json`。
3. 上游 `n` 必须为 1，否则 400 `n must be 1`。
4. 未使用字段返回空字符串，必须归一化为 `null`。
5. 输出 URL 主机是 `platform-outputs.agnes-ai.space`，不要写死。

实现完成后运行 `deno task smoke` 复验这些结论；把差异写进 README，不要打印或提交 Key。`.probe/` 与 `test-key.txt` 必须保持在 `.gitignore` 中。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "docs: document deployment, API usage and limits"
```
