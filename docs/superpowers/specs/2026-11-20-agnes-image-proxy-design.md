# Agnes Image Reverse — 设计

> 2026-11-21 更新：尺寸 auto、参考图读头与默认 ratio 的语义已由
> `2026-11-21-agnes-auto-size-design.md` 覆盖；本文件中相关段落仅作历史记录。

日期：2026-11-20
状态：待评审

## 一、意图

Agnes 的图像模型本身是 OpenAI 风格网关，但只在 `/v1/images/generations` 上工作：
图生图要把参考图放进 JSON 的 `extra_body.image`，尺寸是 `1K–4K + ratio` 档位，输出可能是
URL 或 Base64，`response_format` 的位置也与 OpenAI 相反。任何按 OpenAI Images API 写的客户端
——`client.images.edit()`、Open WebUI、SillyTavern、只认 `gpt-image-1` 的脚本——都无法直接使用。

本项目是一个部署在 Deno Deploy 上的反向代理：客户端说 OpenAI Images API，代理翻译成 Agnes API，
并把多个 Agnes API Key 聚合成一个池子轮询使用。模型名原样透传，**不做任何名称映射**。

### 两个必须跑通的场景

1. `POST /v1/images/generations`：纯文本提示词出图。
2. `POST /v1/images/edits`：一至多张参考图 + 提示词出图（OpenAI 的 multipart 上传方式）。

### 成功标准

- 官方 `openai` SDK（Python / Node）只改 `base_url` 与 `api_key` 就能调用两个端点，无需 `extra_body`。
- `openai.images.generate(...)` 与 `openai.images.edit(image=...)` 的返回值能通过 SDK 的模型校验，
  图片可解码保存。
- 多个 Key 中任意一个失效、限流或超时，请求自动落到下一个可用 Key。
- `/admin` 提供与 Worker-AI-Reverse 同风格的五板块控制台：总览、图片、账号、日志、设置。
- 控制台「图片」时间线能按时间回看每次请求生成的输出图，并删除不需要的图片。
- `n>1` 时有部分失败仍返回成功的图，并在 `X-Agnes-Succeeded/Failed` 里给出计数。

## 二、非目标

- 不做模型名映射（`gpt-image-1` 不会变成 `agnes-image-2.5-flash`）。
- 不代理文本（`/v1/chat/completions`）、视频（`/v1/videos`）、向量化。
- 不实现 OpenAI 的 `mask` 局部重绘：Agnes 没有对应能力，带 `mask` 的请求明确返回 400。
- 不转码图片（不把 PNG 转 JPEG/WebP）、不做透明背景、不放大或缩小上游输出。
- 不做流式（`stream=true`、`partial_images`）。
- 不存储参考输入图：时间线只展示输出图。
- 不提供图片编辑、裁剪或缩放：归档的是上游原图字节。
- 不做计费/配额扣减；只记录用量。

## 三、整体结构

```
client ──/v1/images/{generations,edits}──▶ protocol.ts ──▶ pool.ts ──▶ agnes.ts ──▶ apihub.agnes-ai.com
                                              │            (多个 Key 轮询/故障转移)
                                              │
                                         logs.ts / model-usage.ts / gallery.ts
                                              │
operator ──/admin──▶ console: 总览 · 图片 · 账号 · 日志 · 设置
                                              │
                                         Turso (libSQL)
```

技术栈与 Worker-AI-Reverse 保持一致：Deno 2、Web 标准 TypeScript、无构建步骤、仅一个运行时依赖
`@libsql/client/web`。`Worker-AI-Reverse/` 只作为参考，不参与构建、测试或部署，列入 `.gitignore`。

**部署目标仍是 Deno Deploy。** 已确认 Deno Deploy 将于约 2027 年 4 月关闭，本项目接受这个期限，
不在本期处理迁移。作为副作用，代码只使用 Web 标准 API，Deno 专有调用（`Deno.serve`、`Deno.env`）
集中在 `main.ts`，将来真要迁移时改动面很小；但不把可移植性当作本期目标。

## 四、HTTP 面

### 数据面（只认 Bearer `PROXY_API_KEY`，永不接受 Cookie）

| 方法 | 路径 | 用途 |
| - | - | - |
| POST | `/v1/images/generations` | 文生图；也接受带参考图的请求（等价于编辑） |
| POST | `/v1/images/edits`、`/v1/images/edit` | 图生图 / 多图合成；单数别名兼容 |
| GET | `/v1/models` | 静态目录中的 Agnes 图像模型 |
| GET | `/health`、`?deep=1` | 存活探针；deep 检查数据库 |
| GET | `/` | 跳转 `/admin` |

### 管理面

与 Worker-AI-Reverse 相同的路由形状：`/admin` 页面、`POST/DELETE /admin/api/session`、
`/admin/api/overview`、`/admin/api/accounts`（增删改、测试、恢复、批量导入）、
`/admin/api/logs`、`/admin/api/settings`。管理 API 接受会话 Cookie 或 Bearer 密钥。

图片归档额外提供：

| 方法 | 路径 | 用途 |
| - | - | - |
| GET | `/admin/api/gallery?before=<id>&limit=<n>` | 时间线分页，返回元数据，不含字节 |
| GET | `/admin/api/gallery/:id/content` | 返回归档图片字节 |
| DELETE | `/admin/api/gallery/:id` | 删除一张 |
| DELETE | `/admin/api/gallery` | 清空全部 |

## 五、请求翻译

### 5.1 `/v1/images/generations`

接受并消费：

| 客户端字段 | 去向 |
| - | - |
| `model` | 原样 |
| `prompt` | 原样 |
| `size` | 解析后变成 Agnes `size` + `ratio`（见 5.3） |
| `ratio` | 原样；与 `size` 一起决定输出 |
| `response_format`（顶层） | 归位到 Agnes 的 `extra_body.response_format` |
| `return_base64` | 原样 |
| `n` | 代理自行扇出（见 5.4） |
| `extra_body` | 已知键归位后透传，未知键原样透传 |
| `image` / `images` | 若有，按图生图构造 payload（与 edits 共用逻辑） |

仅警告、不生效：`quality`、`background`、`output_format`、`output_compression`、`moderation`、
`style`、`input_fidelity`、`user`、`safety_identifier`。响应头
`X-Agnes-Warnings: quality,background` 明示被忽略的字段。

直接 400：`stream=true`、`partial_images`（Agnes 无流式）。

未知顶层字段：忽略并加入 `X-Agnes-Warnings`，不报错，保证客户端兼容性。

### 5.2 `/v1/images/edits`

两种请求形状都接受：

- `multipart/form-data`：`image` 或 `image[]` 文件（1–16 张）、`mask`、`model`、`prompt`、`size`、
  `n`、`quality`、`response_format` 等表单字段。
- `application/json`：OpenAI 新形状 `images: [{image_url} | {file_id}]`，也接受 `image`/`images`
  为字符串或字符串数组（Agnes 原生形状）。

处理规则：

- 文件字节转成 `data:<mime>;base64,…`；只接受 `image/png`、`image/jpeg`、`image/webp`。
- `mask` 存在 → 400 `unsupported_parameter`，说明 Agnes 不支持遮罩。
- `file_id` → 400 `unsupported_parameter`（本代理不提供 OpenAI 文件上传端点）。
- 图片 URL 必须是 http(s) 或 data URI；其余 400。
- 合并字段后构造 Agnes 请求：
  - `extra_body.image`: string[]（URL 或 Data URI）
  - `extra_body.response_format`: `"url"` 或 `"b64_json"`
  - `size` + `ratio`（`ratio` 仅在客户端显式提供时发送）

### 5.3 尺寸翻译

> 2026-11-21 起，`auto` 语义改为读取第一张参考图的真实分辨率并以 `WIDTHxHEIGHT` 发送；URL 参考图
> 由代理受控读头，失败返回 400。以下为旧行为记录。

输入可以是 Agnes 档位（`1K…4K`）或任意 `WxH`（含 `auto`）。代理输出档位 + `ratio`。

- 档位按面积在 1K≈1.05MP、2K≈4.19MP、3K≈9.44MP、4K≈16.78MP 中取对数距离最近者。
- 比例取 `1:1, 3:4, 4:3, 16:9, 9:16, 2:3, 3:2, 21:9` 中对数距离最近者。
- 显式 `ratio` 优先于从像素推算的比例；未提供 `ratio` 时不再补默认值（Agnes 默认 1:1）。
- 显式档位（`size: "3K"` / `"4K"`）原样保留，代理不做封顶。
- 旧行为：`auto` 只在参考图是上传文件或 Data URI 时解析像素；URL 退回 `1K + 1:1`。新行为见
  `2026-11-21-agnes-auto-size-design.md`。
- 例：`1024x1024→1K/1:1`；`1536x1024→1K/3:2`；`1792x1024→1K/16:9`；
  `2560x1440→2K/16:9`；`4096x4096→4K/1:1`。
- 响应头 `X-Agnes-Resolved-Size` 暴露请求表达式，响应体 `size` 记录第一张成功输出图的实际像素
  （测量失败时退回预期原生尺寸）。

图片尺寸解析只读文件头：PNG（IHDR）、JPEG（SOF 标记）、WebP（VP8/VP8L/VP8X），约 100 行，无依赖。

### 5.4 `n` 与部分成功

Agnes 没有 `n`。代理把 `n` 次调用一次性并发扇出（并发数 = `n`），每个子请求省略 `n`，并独立从池子领取 Key。

- `n` 只要求是正整数（`Number.isSafeInteger(n) && n >= 1`），**不设 1–10 的协议上限，也不按分辨率
  或输出体积收紧**。上游的 RPM、内存与平台限制由上游/平台自行报错。
- **部分成功也返回**：收集所有子请求的结果；成功数 ≥1 时返回 200，`data` 只含成功的图（保持原
  请求顺序），并带响应头：
  - `X-Agnes-Requested: n`
  - `X-Agnes-Succeeded: k`
  - `X-Agnes-Failed: n-k`
  - `X-Agnes-Warnings: partial-success`（仅当 `k < n`）
  - `X-Agnes-Failure-Statuses: 429,400`（去重后的失败状态码）
- 成功数为 0 时返回第一个子请求的错误信封与状态码。
- 日志记录 `requested`、`images`（成功数）、`failed`；`ok = failed === 0`。模型用量在成功数 ≥1 时
  `requests + 1`，有失败时 `errors + 1`，`images += k`。
- 每个成功子请求独立累加其账号的请求数与图片数；失败按池子的冷却规则处理。归档只处理成功的图。
- 上游实测对 `n != 1` 返回 400 `n must be 1`，所以扇出是必需的。

### 5.5 上游字段放置

文档自身矛盾：参数表写顶层 `image`，所有示例与警告写 `extra_body.image`。代理设置项
`image_param_mode`：

- `auto`（默认）：先按 `extra_body.image` 发送；若编辑请求返回 400，自动改用顶层 `image` 重发一次，
  成功后把可用模式缓存 10 分钟。仅编辑请求会触发这次额外尝试。
- `nested` / `top_level`：固定一种，便于排查。

`response_format` 始终放在 `extra_body` 内（文档明确要求），`return_base64` 始终在顶层。

**实测（2026-11-20）**：该网关同时接受 `extra_body.image` 与顶层 `image`，也同时接受
`extra_body.response_format` 与顶层 `response_format`；文档里“顶层会报错”没有复现。默认仍按文档
使用嵌套，`auto` 回退作为兼容保险保留。

### 5.6 响应

成功统一为 OpenAI 信封：

```json
{
  "created": 1780000000,
  "data": [{ "url": null, "b64_json": "iVBORw0KGgo...", "revised_prompt": null }],
  "size": "1024x1024",
  "output_format": "png"
}
```

- 默认返回 `b64_json`（对齐 GPT Image 客户端）；`response_format: "url"` 时返回 Agnes 的临时 URL。
- Base64 的强制方式按文档走：文生图在顶层发 `return_base64: true`；图生图发
  `extra_body.response_format: "b64_json"`。客户端显式写 `return_base64: false` 或
  `response_format: "url"` 时，以客户端为准。
- **客户端响应不等待下载或转码。** 如果请求了 Base64 但上游仍给了 URL，就原样返回 URL 并加警告；
  归档会在响应之后单独下载这个 Agnes 返回的 URL（见第六节），二者互不阻塞。
- `data` 中两项都保留（未使用的一项为 `null`），与 OpenAI 一致。
- `n > 1` 的部分成功语义见 5.4：HTTP 200、`data` 只含成功图、计数在 `X-Agnes-*` 头。
- **上游把未使用的字段返回为空字符串**（`"url": ""`、`"b64_json": ""`、`"revised_prompt": ""`）；
  规范化时一律转成 `null`，不能让空串进入 OpenAI 响应。
- 实测文生图 `return_base64: true` 与图生图 `extra_body.response_format: "b64_json"` 都返回
  `b64_json`；1K（1024×1024）PNG 的 Base64 约 0.7–1.1 MB。
- 不伪造 `usage`。
- 不支持的字段通过 `X-Agnes-Warnings` 告知。
- `revised_prompt` 固定为 `null`。

错误统一为 OpenAI 嵌套信封：

```json
{ "error": { "message": "…", "type": "invalid_request_error", "param": "mask", "code": "unsupported_parameter" } }
```

状态码：客户端参数错误 400、鉴权失败 401、未知路径 404、上游 429 透传 429、上游 5xx 透传 502/504、
所有 Key 冷却耗尽 503。上游错误体尽量保留其 `message`。

### 5.7 模型目录与尺寸能力

> 2026-11-21 更新：`agnes-image-2.0-flash` 已移除；所有登记模型使用 `tier` 尺寸，`auto` 语义见
> `2026-11-21-agnes-auto-size-design.md`。

`lib/model-catalog.ts` 静态登记两个图像模型，`/v1/models` 与管理端模型表都以它为准：

| 模型 | 尺寸模式 | 说明 |
| - | - | - |
| `agnes-image-2.5-flash` | `tier` | `1K–4K` + `ratio`，当前主推 |
| `agnes-image-2.1-flash` | `tier` | 与 2.5 参数一致 |

未登记的模型（例如客户端硬编码的其他名字）仍然原样透传，尺寸按 `tier` 模式处理；上游拒绝就
把上游错误返回，代理不替客户端猜。

## 六、图片归档与时间线

每个成功生成并返回给客户端的输出图归档一行；参考输入图不入库。

**字节从哪里来**

- 上游返回 `b64_json`：直接 Base64 解码为字节，存 `BLOB`。
- 上游返回 URL：客户端响应发出后，代理下载这个 URL 并存入 `BLOB`。只下载 Agnes 响应里给出的
  输出 URL（2026-11-21 起，参考图 auto 尺寸路径也会受控读取客户端 URL 的图片头，见新 spec）；
  下载只允许 `https`，拒绝私网/回环地址，拒绝解析到私网的重定向，上限 64 MiB、60 秒超时。**实测
  输出 URL 的主机是 `platform-outputs.agnes-ai.space`，代码不写死主机**，只做通用校验。
- 归档行的 `size` 取归档字节的实际宽高；没有字节时保留预期原生尺寸。
- 下载或写库失败不改变客户端已经拿到的响应；gallery 行保留 `source_url` 且 `archived=0`。
  大图触发 Turso 单行/请求体积限制时同样退化为这种状态，不重试、不阻塞。

**展示**

- 时间线按 `id DESC` 分页，默认 24 张，游标是上一页最后一条 id；按 UTC 日期分组。
- 缩略图就是原图，浏览器懒加载；点击打开大图与元数据（提示词、模型、尺寸、账号、时间、字节数）。
- 单张删除与清空全部；不设自动保留上限，删除由用户决定。
- `archived=0` 的条目显示占位卡与原始链接，不把外部 URL 放进 `<img>`，CSP 不放宽到第三方图片。
- 图片读取走 `/admin/api/gallery/:id/content`，需要会话或 Bearer；返回入库的 MIME，
  `Cache-Control: private, max-age=300`、`nosniff`。

**并发与生命周期**

- 归档不阻塞响应：Deno Deploy 上用 `EdgeRuntime.waitUntil`，本地与测试没有该全局时退回 await。
- 归档失败只写一条警告日志，不影响请求日志、模型用量或客户端响应。

## 七、Agnes 上游客户端

- 基础地址默认 `https://apihub.agnes-ai.com/v1`，可存于设置。
- 池中每个 Key 来自**独立的 Agnes 账号**，各自的 RPM 与配额池互不影响，因此按 Key 轮询与冷却
  能真正提升吞吐。Agnes 的规则是“同类型 Key 共享限流池”，同一账号下再加 Key 不会叠加额度；
  控制台在批量导入时提示这一点，但代理不替用户去重。
- 每个请求最多尝试 3 个 Key；multipart 已转成可重放的 JSON payload，因此重试无需重新读文件。
- 超时默认 300 秒（可设置 60–360 秒），超时返回 504。3K/4K 在免费档只有 1 actual RPM，单张可能
  接近一分钟；`n>1` 时如果可用 Key 不足，子请求会被上游限流，代理不做额外排队或截断。
- 失败分类：
  - 401/403 → 该 Key `degraded`，冷却 15 分钟。
  - 429 → 冷却 `Retry-After` 或 60 秒，换下一个 Key。
  - 5xx / 超时 / 传输错误 → `degraded`，60 秒起指数退避，最长 15 分钟。
  - 400 / 404 → 直接返回，不换 Key（换也没用）。
  - 成功 → 清零失败计数。
- 上游错误是 OpenAI 嵌套信封 `{ "error": { "message", "type", "param", "code" } }`（实测 `code` 是
  字符串，如 `invalid_request`）；客户端消息优先取 `error.message`，没有时用纯文本 body。
- 池子领取是数据库原子语句：`UPDATE accounts SET last_used_at=… WHERE id=(SELECT … ORDER BY last_used_at, id LIMIT 1) RETURNING …`，
  只取启用且冷却已结束的 Key。
- Key 以明文存库、对外一律掩码为 `agk_…abcd`。

## 八、数据模型（Turso）

| 表 | 关键列 |
| - | - |
| `accounts` | id, name, api_key, enabled, status, cooldown_until, fail_count, last_used_at, request_count, image_count, created_at |
| `request_log` | id, ts, endpoint, model, account_id, status, duration_ms, requested, images, failed, size, error, attempts |
| `model_usage_daily` | model, day, requests, errors, images, last_used_at（主键 model+day） |
| `gallery` | id, ts, endpoint, model, account_id, account_name, prompt, size, tier, ratio, mime, bytes BLOB, byte_size, source_url, archived, created_at |
| `settings` | key, value |

- `gallery.bytes` 是原始图片字节（BLOB），不是 Base64；`archived=0` 时为空，只有 `source_url`。
- 日志保留最新 500 行，插入时顺带裁剪（Deno Deploy 无 cron）；gallery 不自动裁剪。
- 用量按 UTC 天累计；总览页模型表合并静态目录与用量，未使用的模型显示 0。
- 首次请求建表，无迁移脚本；版本升级直接重建（与参考项目一致）。

## 九、控制台

沿用 Worker-AI-Reverse 的视觉与交互：简体中文、亮色、系统字体、内联 SVG 图标、无外部资源；
桌面侧栏、窄屏底部导航；表格在窄屏变记录卡；URL fragment 选板块（`/admin#gallery`）。

- **总览**：今日请求/错误/图片数、健康 Key 数、按模型用量表（可切日期）。
- **图片**：按日期分组的输出图时间线；懒加载缩略图；点击看大图、提示词、模型、尺寸、账号、
  时间、字节数；单张删除；清空全部；`archived=0` 显示占位与原始链接。
- **账号**：添加（名称 + Key）、编辑名称、启用/停用、删除、单个测试、全部测试、恢复冷却、
  批量导入（每行 `名称,Key`）。测试发一次 1K 的最小真实出图请求，消耗一张图，页面先确认。
- **日志**：最新 200 条，5 秒自动刷新（选中文字时暂停），可清空；每条显示 `succeeded/requested`，
  部分失败时同时显示失败数与状态码。
- **设置**：Agnes 基础地址、默认 `response_format`、默认档位、`image_param_mode`、
  测试模型、测试并发、请求超时、最大尝试次数。（`defaultRatio` 已于 2026-11-21 移除。）

登录：`/admin` 无会话时只返回登录页；登录用 `PROXY_API_KEY` 换 HMAC 签名会话 Cookie
（`HttpOnly`、`SameSite=Lax`、HTTPS 下 `Secure`、`Path=/admin`、30 天滑动续期）；
退出只清 Cookie，轮换 `PROXY_API_KEY` 可作废全部会话。

## 十、安全

- 缺少 `PROXY_API_KEY`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` 时拒绝启动。
- 数据面只认 Bearer；管理面 Cookie 永不被数据面接受。
- 控制台 CSP `default-src 'none'`，只允许自身连接与内联样式/脚本；`X-Frame-Options: DENY`、
  `nosniff`、`no-referrer`；`Cache-Control: no-store`。图片由同源内容端点提供，`img-src 'self' data:`。
- CORS 默认关闭；`CORS_ALLOWED_ORIGINS` 逗号分隔白名单，仅数据面接受预检。
- 请求体上限 32 MiB（同时看 `Content-Length` 与实际字节）；单张输入图上限 20 MiB；最多 16 张。
- 代理不设输出体积预算、不按档位限制 `n`：极端组合（4K × `n=10` × Base64）可能触及 isolate 的
  内存上限，这是明确接受的取舍；上游限流错误原样返回。
- 只有 `auto` 需要参考图尺寸时，代理才会请求客户端提供的参考图 URL 并只读取图片头：允许
  `http`/`https` 与公网主机；拒绝私网/回环/链路本地/带凭据的地址；每次重定向重新校验；10 秒
  超时、1 MiB 上限、最多 2 次重定向；失败返回 400。输出 URL 读头只允许 `https`。与归档下载一样，
  不额外实现 DNS rebinding 防护。
- 归档下载只接受 Agnes 响应里给出的输出 URL，并校验
  `https`、私网/回环地址、重定向、64 MiB 上限与 60 秒超时。
- gallery 内容端点需要会话或 Bearer，`archived=0` 的条目不会暴露第三方图片到页面。
- 密钥比较不泄漏长度与前缀。

## 十一、配置

| 变量 | 必需 | 说明 |
| - | - | - |
| `PROXY_API_KEY` | 是 | 客户端 Bearer 令牌，也是控制台密码 |
| `TURSO_DATABASE_URL` | 是 | `libsql://…` 或 `https://…` |
| `TURSO_AUTH_TOKEN` | 是 | Turso 令牌 |
| `PORT` | 否 | 本地端口，默认 8000；Deno Deploy 忽略 |
| `CORS_ALLOWED_ORIGINS` | 否 | 跨域白名单，默认关闭 |

## 十二、文件结构

```
main.ts                 读环境变量、建库、装配、Deno.serve
lib/app.ts              路由、鉴权、CORS、错误映射
lib/protocol.ts         OpenAI 请求解析 + Agnes payload 构造 + 响应规范化
lib/size.ts             像素/档位/比例翻译
lib/image-dimensions.ts PNG/JPEG/WebP 尺寸读取
lib/agnes.ts            Agnes HTTP 客户端（超时、错误分类）
lib/pool.ts             原子领取、故障转移、冷却
lib/accounts.ts         schema、账号存储、每日用量、认领游标
lib/logs.ts             请求日志（500 行上限）
lib/model-usage.ts      按模型按天用量
lib/model-catalog.ts    静态 Agnes 图像模型目录
lib/gallery.ts          gallery schema、写入、分页、读取字节、删除
lib/archive.ts          响应图 → gallery 行；Agnes URL 的安全下载
lib/settings.ts         数据库设置 + 短缓存
lib/auth.ts             HMAC 会话签名
lib/sql.ts              SqlExecutor 端口 + libSQL 驱动（支持 BLOB）
lib/http.ts             JSON/错误/响应头辅助
lib/errors.ts           ApiError
lib/limits.ts           体积、数量、超时、冷却、归档常量
web/ui.ts               控制台入口，导出两个页面
web/console.ts          总览/账号/日志/设置 + 板块外壳
web/gallery.ts          图片时间线的渲染与交互
web/login.ts            登录页
web/styles.ts           设计令牌与响应式样式
web/icons.ts            内联 SVG sprite
tests/                  按 lib/ 与 web/ 镜像
scripts/harness.ts      测试与预览共用装配
scripts/preview.ts      内存 SQLite + 示例数据，端口 8001
scripts/smoke.ts        真实 Agnes 流量的端到端脚本
docs/superpowers/specs/ 本文件
```

## 十三、测试

- 协议层表驱动测试：两个端点、multipart/JSON、尺寸翻译、`n` 扇出、
  忽略字段、错误信封、`response_format` 两处写法、`image_param_mode` 自动回退。
- 限额：`n` 只拒绝非正整数、`n=25` 正常扇出（没有 10 的上限）、3K/4K 不被改写、单图与请求体上限；
  确认代理不对分辨率或 `n` 组合提前报 400。
- 部分成功：`n=5` 中 2 个失败 → 200、`data` 3 张、`X-Agnes-Succeeded/Failed` 正确；全部失败 →
  第一个错误的状态与信封；日志的 `requested/images/failed/ok` 正确。
- 安全：客户端提供的 URL 不会触发代理发起外部请求；归档下载只接受 Agnes 响应里的 URL，
  并拒绝私网、超限、超时与错误 MIME。
- 归档：BLOB 往返、`b64_json` 与 URL 两种来源、下载失败退化为 `archived=0`、分页游标、
  删除与清空、内容端点的鉴权与 MIME。
- 池子：轮询顺序、401/429/5xx/超时的冷却与换号、不重试 400、最多 3 次。
- 存储：用真实 SQLite 引擎（测试期 `node:sqlite`，生产 `@libsql/client/web`）跑同一套 SQL。
- Web：页面渲染包含关键区块、未登录不泄漏控制台、CSP 头、时间线空状态。
- 全部离线；`deno task smoke` 需要真实 Agnes Key，可选。
- 目标：`deno task fmt:check && deno task lint && deno task check && deno task test` 全绿。

## 十四、部署

推到 GitHub → Deno Deploy 以 `main.ts` 为入口 → 配三个必需环境变量 → 打开 `/admin` 登录、
添加 Key。`deno.json` 自带 `start/preview/smoke/test/lint/fmt/check` tasks。

Deno Deploy 约在 2027 年 4 月关闭，这是已知并接受的外约束；本期不写迁移脚本，也不为其他托管平台
做适配。README 会在部署一节写明这个日期。

## 十五、我做出的决定（可被覆盖）

1. **新鲜实现，不复制 Worker-AI-Reverse 代码**：该仓库声明 UNLICENSED、不供复用；界面风格照做，
   代码重写。
2. **默认 `b64_json` 输出**：对齐 GPT Image 客户端与 Open WebUI；URL 需显式请求。
3. **`mask`、`stream` 返回 400**：不静默产生用户没要求的整图编辑。
4. **`quality`/`background`/`output_format` 等仅警告**：这些是常见客户端会顺手带的字段，
   直接拒绝会大幅降低兼容性。
5. **`n` 由代理扇出**：正整数、无 1–10 上限、并发数 = `n`；不按分辨率或输出体积收紧，也不做
   代理侧排队。成功数 ≥1 时返回 200 与成功的图，失败计数放进 `X-Agnes-*` 头；全部失败才返回错误。
6. **尺寸翻译不设上限**：显式 `3K`/`4K` 与超大像素都按最近的档位原样发送，代理不封顶。
7. ~~**`auto` 尺寸只从本地可读的图推比例**~~：2026-11-21 已由新 spec 覆盖——`auto` 读取第一张
   参考图的真实分辨率（URL 由代理受控读头），失败返回 400。
8. **`image_param_mode: auto` 自动回退**：解决文档中顶层 `image` 与 `extra_body.image` 的自相矛盾；
   实测两种都可用，默认嵌套，回退逻辑只是保险。
9. **测试用真实 SQLite、生产用 libSQL**：与参考项目同一思路，保证 SQL 行为一致。
10. ~~**2.0 用 `exact` 尺寸模式**~~：2026-11-21 起该模型已移除；参考图 auto 改用新的 `exact`
    模式（见 `2026-11-21-agnes-auto-size-design.md`）。
11. **不去重同账号 Key**：池子按独立账号设计；同账号多 Key 共享限流是 Agnes 的规则，控制台提示，
    但不阻止。
12. **图片归档存本体**：担心 Agnes URL 过期，所以 `b64_json` 直接存 BLOB，URL 输出由归档路径下载
    后存 BLOB。只存输出图，不存参考图。
13. **归档不阻塞客户端响应**：`EdgeRuntime.waitUntil`（本地/测试退回 await）；下载或写库失败
    退化为 `archived=0`，保留 `source_url`。
14. **不做 gallery 自动保留上限**：删除与清空由用户在控制台决定。
15. **空字符串归一化为 `null`**：实测上游未使用字段返回 `""`，不转换会让 OpenAI 客户端把空串当 URL。
16. `Worker-AI-Reverse/` 列入 `.gitignore`，只作本地参考。
