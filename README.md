# Agnes Image Reverse

把 **Agnes 图像 API** 包装成 **OpenAI Images API** 的兼容层，部署在 Deno Deploy 上，并自带多 Key
账号池、请求日志、用量统计与图片时间线。

- 客户端只需要改 `base_url` 与 `api_key`，官方 `openai` SDK（Python / Node）即可调用两个端点。
- 代理把多个 Agnes API Key 聚合成一个池子轮询使用；任意 Key 失效、限流或超时，请求自动落到下一个可用
  Key。
- 控制台 `/admin`
  提供总览、图片、账号、日志、设置五个板块；深色/浅色主题首次跟随系统，右上角可随时切换。
- 图库卡片默认加载 Edge-Images 生成的缩略图；归档时自动取得 nsfwjs 五分类并落为 tag，可按分类筛选、
  手动补齐历史图片。

模型名原样透传，**不做名称映射**——`gpt-image-1` 不会变成 `agnes-image-2.5-flash`，请直接使用 Agnes
的模型名（见下文模型目录）。

## 端点

| 方法 | 路径                                  | 用途                                                           |
| ---- | ------------------------------------- | -------------------------------------------------------------- |
| POST | `/v1/images/generations`              | 文生图；也接受 JSON 里的 `image` / `images` 参考图             |
| POST | `/v1/images/edits`、`/v1/images/edit` | 图生图 / 多图合成；支持 `multipart/form-data` 与 JSON 两种形状 |
| GET  | `/v1/models`                          | 静态目录中的 Agnes 图像模型                                    |
| GET  | `/health`、`/health?deep=1`           | 存活探针；deep 会检查数据库                                    |
| GET  | `/`                                   | 跳转 `/admin`                                                  |

数据面只接受 `Authorization: Bearer <PROXY_API_KEY>`，永不接受 Cookie。管理面接受会话 Cookie
或同一个 Bearer。

### 模型目录

| 模型                    | 尺寸模式                  |
| ----------------------- | ------------------------- |
| `agnes-image-2.5-flash` | `1K–4K` + `ratio`（tier） |
| `agnes-image-2.1-flash` | `1K–4K` + `ratio`（tier） |

目录外的模型名仍会原样转发，尺寸按 tier 处理；上游拒绝时原样返回上游错误。

## 快速开始

### 1. 准备 Turso

```bash
turso db create agnes-image
turso db show agnes-image --url        # libsql://… 或 https://…
turso db tokens create agnes-image     # TURSO_AUTH_TOKEN
```

首次请求会自动建表，没有迁移脚本。

### 2. 本地运行

```bash
deno task preview
# 打开 http://localhost:8001/preview-shot 自动登录
# 或 http://localhost:8001/admin 使用密钥 preview 登录
```

`deno task preview` 使用内存 SQLite 与示例数据，不会消耗真实额度。

生产运行：

```bash
PROXY_API_KEY=... \
TURSO_DATABASE_URL=libsql://... \
TURSO_AUTH_TOKEN=... \
PORT=8000 deno task start
```

### 3. 部署到 Deno Deploy

推到 GitHub → 在 Deno Deploy 新建项目，入口选 `main.ts` → 配置
`PROXY_API_KEY`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` → 打开 `/admin` 登录并添加 Key。

> **注意**：Deno Deploy 计划于约 **2027 年 4
> 月**关闭。本项目接受这个期限，不在本期做迁移；代码只使用 Web 标准 API，`Deno.serve` / `Deno.env`
> 集中在 `main.ts`，将来迁移的改动面很小。

### 4. 客户端示例

Python：

```python
import base64
from openai import OpenAI

client = OpenAI(base_url="https://your-proxy.example/v1", api_key="PROXY_API_KEY")

result = client.images.generate(
    model="agnes-image-2.5-flash",
    prompt="一只坐在窗台上的橘猫，午后阳光",
    size="1024x1024",
)
with open("output.png", "wb") as f:
    f.write(base64.b64decode(result.data[0].b64_json))

with open("reference.png", "rb") as image:
    edited = client.images.edit(
        model="agnes-image-2.5-flash",
        image=image,
        prompt="把背景换成海边",
        size="1024x1024",
    )
```

Node：

```js
import fs from "node:fs/promises";
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "https://your-proxy.example/v1", apiKey: "PROXY_API_KEY" });

const result = await client.images.generate({
  model: "agnes-image-2.5-flash",
  prompt: "a red apple on a white table",
  size: "1024x1024",
});
await fs.writeFile("output.png", Buffer.from(result.data[0].b64_json, "base64"));

const image = await fs.readFile("reference.png");
const edited = await client.images.edit({
  model: "agnes-image-2.5-flash",
  image,
  prompt: "turn the apple blue",
  size: "1024x1024",
});
```

默认返回 `b64_json`；显式请求 `response_format: "url"` 时返回 Agnes 的临时 URL。

## 环境变量

| 变量                   | 必需 | 说明                                   |
| ---------------------- | ---- | -------------------------------------- |
| `PROXY_API_KEY`        | 是   | 客户端 Bearer 令牌，也是控制台登录密码 |
| `TURSO_DATABASE_URL`   | 是   | `libsql://…` 或 `https://…`            |
| `TURSO_AUTH_TOKEN`     | 是   | Turso 令牌                             |
| `PORT`                 | 否   | 本地端口，默认 8000；Deno Deploy 忽略  |
| `CORS_ALLOWED_ORIGINS` | 否   | 逗号分隔的跨域白名单，默认关闭         |
| `RESET_SCHEMA`         | 否   | 只有 `deno task reset-db` 需要设为 `1` |

缺少前三个变量时进程拒绝启动。

## 账号池语义

- 池中的每个 Key 应来自**独立的 Agnes 账号**。Agnes 的规则是“同类型 Key
  共享限流池”，**同一账号下再加 Key
  不会叠加额度**；控制台批量导入时会提示这一点，但代理不替用户去重。
- 每次请求最多尝试 3 个 Key（可在设置里调整）。失败分类：
  - `401/403` → 该 Key 冷却 15 分钟；
  - `429` → 冷却 `Retry-After`，没有时 60 秒；
  - `5xx / 超时 / 传输错误` → 60 秒起指数退避，最长 15 分钟；
  - `400 / 404` → 直接返回，不换 Key（换也没用）；
  - 成功 → 清零失败计数。
- 所有 Key 都失败时按 `429 > 504 > 502 > 503` 选择最终状态码；存在 429 时取封顶后冷却最短的
  那个，`Retry-After` 同样封顶 900 秒。`n > 1` 时同一优先级会跨子请求再应用一次。
- 成功写回使用 `fail_count` CAS：一个请求的成功不会清掉并发失败请求刚写入的冷却。
- 上游超时默认 300 秒，可在设置里调整为 60–360 秒；超时映射为 504。

## 尺寸与 n

- 客户端可传 Agnes 档位（`1K`–`4K`）、任意 `WxH`，或省略 `size` / 传 `auto`。显式档位与显式 `WxH`
  由代理按面积与比例的对数距离折成最近的档位 + 比例；客户端没有显式给 `ratio` 时 payload 里不再出现
  `ratio`，由 Agnes 使用默认 1:1。`X-Agnes-Resolved-Size` 暴露本次请求表达式： `2K 16:9`、`900x1200`
  或 `2K`。
- `size` 未传、为空或大小写不敏感等于 `auto`，且带参考图时，代理读取**第一张参考图的真实分辨率**，
  以 `WIDTHxHEIGHT` 作为上游 `size`。参考图来源：multipart 上传、`data:` URI、http(s) URL
  （由代理受控读取图片头）。第一张读不到直接返回 400，不再静默退回 `1K + 1:1`。
- 显式给了 `size` 的请求完全不读取、不下载参考图。
- Agnes 会把精确 `WIDTHxHEIGHT` 归一化到自己的档位 / 比例表，因此**不能保证输出正好等于参考图
  分辨率**；实测 `900x1200` 得到 `864x1152`。
- 响应体 `size`、请求日志 `size_actual`、图片时间线 `size` 都记录**实际输出尺寸**：响应取第一张
  成功图；日志按出现顺序去重后用逗号连接；相册取归档字节。测量失败时响应退回预期原生尺寸并在
  `X-Agnes-Warnings` 标记 `size-measure-failed`，日志尺寸记 `null`。
- 响应体 `output_format` 取第一张成功图字节嗅探出的 `png`/`jpeg`/`webp`；测不到时省略该字段。
- `n` 只要求是正整数，**没有 1–10 的上限**，代理按 `n` 并发扇出。上游实测要求
  `n = 1`，因此扇出是必需的。
- **部分成功也返回**：成功数 ≥1 时 HTTP 200，`data` 只含成功图，并带响应头：

  ```
  X-Agnes-Requested: 5
  X-Agnes-Succeeded: 3
  X-Agnes-Failed: 2
  X-Agnes-Failure-Statuses: 429,400
  X-Agnes-Warnings: partial-success
  ```

  成功数为 0 时按上面的失败优先级选择最终错误信封与状态码。日志与用量严格一致：`requested` /
  `images`（成功数）/ `failed` / `ok = failed === 0`。

## 可观测性

- 每个图片请求生成 `X-Request-Id`（鉴权失败也带，但不写库）；`/v1/models` 不生成。
- `request_log` 记录 `stage`（`parse` / `dispatch` / `complete`）、`error_code`、
  `size_request`/`size_actual`、逐 Key `attempts`（每个子请求的账号、状态、耗时、错误）。
  解析失败也会落库；未鉴权的 401 不落库，防止匿名请求刷掉历史日志。
- 用量指标为 `requests / successes / partials / failures / images`，满足
  `requests = successes + failures`，部分成功同时计入 `successes` 与 `partials`。
- 账号计数字段是 `upstreamRequests` / `upstreamImages`，语义是**成功的上游子请求数与返回图片数**，
  不是客户端请求数；控制台标签为“上游调用 / 图片”。

## 管理面与会话

- 所有 `/admin/api/*` 响应（含 401 与错误）都是 `Cache-Control: no-store`。
- 相册内容端点额外带 `default-src 'none'; sandbox`、`Content-Disposition: inline` 与 `nosniff`；
  只回放 `image/png`、`image/jpeg`、`image/webp`，其他 MIME 返回 404。
- 会话默认 30 天；Cookie 认证的 `/admin/api/*` 在剩余不足 7 天时滑动续期，续期 Cookie 的 `Max-Age`
  等于新 token 的实际剩余时间，总寿命不超过签发后 90 天。`/admin` HTML 与 Bearer 请求不续期。
- `POST /admin/api/session/revoke` 递增会话 epoch，立即作废全部已签发 Cookie；
  `DELETE /admin/api/session` 只清当前浏览器 Cookie，不撤销已泄露的 token。
- 登录失败限速为 isolate 级 best-effort：60 秒窗口内第 11 次失败返回 429 + `Retry-After: 60`，
  成功登录清零；不按 `x-forwarded-for` 分桶（该头可伪造），多 isolate 不共享计数。

## 数据库与 schema

- schema 版本为 `3`。版本不匹配或非空旧库缺少版本时进程拒绝启动，不会自动改表。
- 从 v2 升级到 v3 只新增列与索引，**先对现有库执行下面 9 条 SQL，再部署新代码**；不需要清库，也不
  提供自动迁移分支：

  ```sql
  ALTER TABLE gallery ADD COLUMN thumb BLOB;
  ALTER TABLE gallery ADD COLUMN thumb_mime TEXT;
  ALTER TABLE gallery ADD COLUMN nsfw TEXT;
  ALTER TABLE gallery ADD COLUMN tag TEXT;
  ALTER TABLE gallery ADD COLUMN enrich_status TEXT;
  ALTER TABLE gallery ADD COLUMN enrich_error TEXT;
  ALTER TABLE gallery ADD COLUMN enriched_at TEXT;
  CREATE INDEX IF NOT EXISTS gallery_tag_id ON gallery (tag, id DESC);
  UPDATE schema_meta SET value = '3' WHERE key = 'version';
  ```

- 顺序反过来（先部署新代码）会因版本仍是 `2` 拒绝启动。
- `RESET_SCHEMA=1 deno task reset-db` 仍可作为可选的重来手段；它会**删除账号、请求日志、用量、
  相册与设置**后重建当前 schema，本次升级不需要它。
- 数据库请求 15 秒超时，超时/连接失败映射为 503 `database_timeout` / `database_unavailable`；
  `/health?deep=1` 失败只返回通用 `database unavailable`，不回显原始错误。

## 兼容字段

以下字段不生效，但不会报错；名字会出现在 `X-Agnes-Warnings` 里：
`quality`、`background`、`output_format`、`output_compression`、`moderation`、`style`、`input_fidelity`、`user`、`safety_identifier`，以及未知的顶层字段。

明确返回 400 的情况：`stream: true`、`partial_images`、`mask`、`file_id`、非 `image/png|jpeg|webp`
的上传、非 http(s)/data URI 的参考图 URL。

`image_param_mode`（设置项）控制参考图放在 `extra_body.image`（`nested`，默认）还是顶层
`image`（`top_level`）。上游实测两种位置都接受，只有特殊上游才需要管理员显式选择 `top_level`；
代理不会因为 400 自动改用另一种位置重发。`response_format` 始终放在 `extra_body` 内。

## 图片时间线与存储

- 每个成功生成并返回给客户端的输出图归档一行；参考输入图不入库。
- 上游给 `b64_json` 时直接解码为字节存 `BLOB`；上游给 URL 时在响应发出后下载（仅
  `https`、拒绝私网/回环与指向私网的重定向、上限 64 MiB / 60 秒）再入库。只有嗅探为 png/jpeg/webp
  的字节才会保存；其他内容记录 `archived=0`、`mime=application/octet-stream`。
- 归档行的 `size` 取归档字节的实际宽高；下载失败（`archived=0`）时保留预期原生尺寸与 `source_url`。
- 下载或写库失败不影响客户端响应：gallery 行保留 `source_url` 且
  `archived=0`，控制台显示占位卡与原始链接。
- 时间线按 `id DESC` 分页（默认 24 张），按 UTC
  日期分组；单张删除与清空全部由用户在控制台决定，**没有自动保留上限**。BLOB 存在 Turso
  中，请留意数据库体积与费用。
- 归档后（在 `waitUntil` 内）调用图片服务生成缩略图与 nsfwjs 五分类；卡片优先加载缩略图，失败回退
  原图，查看大图与下载始终用原图。分类标签为普通 / 绘画 / 性感 / 色情 / 动漫色情，未富化显示未分类。
- 缩略图只在比原图更小且能嗅探为图片时保存；返回的「缩略图」不小于原图时不保存缩略图，但仍保存 tag
  与 NSFW 数据。删除与清空图片会随行删除缩略图与 NSFW 数据。

## 图片服务接入（缩略图与 NSFW）

缩略图与 NSFW 分类由外部 **Edge-Images** 服务生成，基址在控制台「设置 →
图片服务」填写；**留空即关闭** （归档与图库照常工作，卡片回退原图，补齐接口返回
`image_service_disabled`）。

| 字段                  | 默认  | 说明                                                                         |
| --------------------- | ----- | ---------------------------------------------------------------------------- |
| `imageServiceBaseUrl` | `""`  | 空=关闭；非空必须 https（localhost/127.0.0.1/[::1] 可用 http），去掉尾部 `/` |
| `thumbnailWidth`      | 640   | 整数 128–2048                                                                |
| `thumbnailQuality`    | 75    | 整数 40–100                                                                  |
| `enrichTimeoutMs`     | 60000 | 整数 5000–60000，与 Edge-Images 服务端超时一致                               |

调用契约：`POST {imageServiceBaseUrl}/api/batch`，请求体是**顶层 JSON 数组**。

- 每项 `{ uuid, base64, contentType, params }`；`uuid = String(gallery.id)`，
  `params = { width: height: thumbnailWidth, crop: "none", size: "down", format: "webp", quality: thumbnailQuality, nsfwjs: 1 }`。
- 响应按 uuid 映射；`data.base64` 是缩略图，`data.nsfw` 是原图的 nsfwjs 五分类
  （`drawing/hentai/neutral/porn/sexy/isNsfw`）。分数最大者成为 `tag`，并列时按
  `neutral, drawing, sexy, porn, hentai` 顺序取靠前者。
- 每批 ≤20 项且源字节累计 ≤32 MiB（发送前自动分块）；单张 >50 MiB 不发起 HTTP，直接记为失败
  `source exceeds 50 MiB`。
- 不要求鉴权头；服务不可达、超时或 nsfwjs 不可用时该批行记为 `failed`，归档与客户端响应不受影响。

历史图片在控制台点击「补齐历史图片」手动处理：一次点击从新到旧走一遍待处理行，失败行不在本遍重试，
下次点击再试。

## 已知取舍

- 请求体上限 32 MiB；单张输入图 20 MiB；最多 16 张。
- 参考图 URL 读头与输出 URL 测量各额外增加一次小请求（通常几百毫秒）；测量失败只降级并告警，
  不会让请求失败。
- 参考图读头允许 `http`/`https`，输出 URL 只允许 `https`；两者共用 10 秒超时、1 MiB 字节上限、 最多
  2 次重定向。与归档下载一样，不额外实现 DNS rebinding 防护，这是已知边界。
- 代理不设输出体积预算、不按档位限制 `n`：极端组合（`4K × n=10 × Base64`）可能触及 isolate
  的内存上限，这是明确接受的取舍；上游限流错误原样返回（429）。
- 不实现 `mask` 局部重绘、不流式、不转码、不缩放；只存输出图，不提供图片编辑。
- 不伪造 `usage`；`revised_prompt` 固定为 `null`；上游未使用字段返回的空字符串一律归一化为 `null`。
- 图片服务是外部依赖：未配置时缩略图 / NSFW / 补齐全部关闭；配置后 Turso 会因缩略图与 NSFW 数据
  增加体积。>50 MiB 的原图无法富化（直接记为失败），历史补齐是手动操作，不做启动自动补齐。

## 上游实测结论（2026-11-21）

| 请求                                 | 结果                                      |
| ------------------------------------ | ----------------------------------------- |
| `size: "auto"`                       | HTTP 400：`size has invalid value "auto"` |
| `size: "900x1200"`                   | HTTP 200；输出图实际为 `864x1152`         |
| `size: "900x1200"` + `ratio: "16:9"` | 输出仍为 `864x1152`，`ratio` 不生效       |
| `size: "2K"`，不传 `ratio`           | 输出 `2048x2048`，Agnes 默认 1:1          |

结论：`auto` 不能透传，必须由代理换算；精确 `WIDTHxHEIGHT` 会被 Agnes 归一化；`ratio` 只在档位
模式下有意义。

## 上游实测结论（2026-11-20）

1. `extra_body.image` 与顶层 `image`、`extra_body.response_format` 与顶层 `response_format`
   都被接受；文档里“顶层会报错”没有复现。默认仍按文档使用嵌套，管理员可在设置中显式选择
   `top_level`。
2. 文生图 `return_base64: true` 返回 `b64_json`；图生图 `extra_body.response_format: "b64_json"`
   也返回 `b64_json`。
3. 上游 `n` 必须为 1，否则 400 `n must be 1`。
4. 未使用字段返回空字符串，必须归一化为 `null`。
5. 输出 URL 主机是 `platform-outputs.agnes-ai.space`，代码不写死主机，只做通用校验。

## 开发

```bash
deno task fmt          # 格式化
deno task fmt:check    # 校验格式
deno task lint         # 静态检查
deno task check        # 类型检查（main/lib/web/scripts/tests）
deno task test         # 离线测试套件（node:sqlite）
deno task preview      # 示例数据 + 内存库，端口 8001
deno task smoke        # 真实 Agnes 端到端（需要 SMOKE_AGNES_API_KEY）
RESET_SCHEMA=1 deno task reset-db  # 删除并重建数据库（破坏性）
```

`smoke` 会真实产生一张文生图与一张图生图请求，消耗账号额度：

```bash
SMOKE_AGNES_API_KEY=agk_... deno task smoke
```

`test-key.txt` 之类的凭据文件不要提交。如果上游对某个 Key 返回账号级限制（例如“unusual
activity”），`smoke` 会以 503 失败并把上游原文带回；换一个可用 Key 即可。

测试必须完全离线；只有 `deno task smoke` 允许真实 Agnes 流量。测试期用 `node:sqlite` 跑同一套
SQL，生产用 `@libsql/client/web`。

### 安全

- 控制台 CSP
  `default-src 'none'`，只允许同源连接与内联样式/脚本；`img-src 'self' data:`；`X-Frame-Options: DENY`、`nosniff`、`no-referrer`、`Cache-Control: no-store`。
- 只有 `auto` 需要参考图尺寸时，代理才会请求客户端提供的参考图 URL，并且只读取图片头： 允许
  `http`/`https` 与公网主机；拒绝私网/回环/链路本地/带凭据的地址；每次重定向重新校验； 10 秒超时、1
  MiB 上限、最多 2 次重定向。输出 URL 读头只允许 `https`。
- 归档下载只接受 Agnes 响应里给出的输出 URL，并校验 `https`、私网/回环地址、重定向与体积上限。
- 与归档下载一样，URL 读头不额外实现 DNS rebinding 防护。
- 密钥比较不泄漏长度与前缀；轮换 `PROXY_API_KEY` 会作废全部会话。
