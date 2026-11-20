# Agnes Image Reverse

把 **Agnes 图像 API** 包装成 **OpenAI Images API** 的兼容层，部署在 Deno Deploy 上，并自带多 Key
账号池、请求日志、用量统计与图片时间线。

- 客户端只需要改 `base_url` 与 `api_key`，官方 `openai` SDK（Python / Node）即可调用两个端点。
- 代理把多个 Agnes API Key 聚合成一个池子轮询使用；任意 Key 失效、限流或超时，请求自动落到下一个可用
  Key。
- 控制台 `/admin` 提供总览、图片、账号、日志、设置五个板块。

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

| 模型                    | 尺寸模式                                       |
| ----------------------- | ---------------------------------------------- |
| `agnes-image-2.5-flash` | `1K–4K` + `ratio`（tier）                      |
| `agnes-image-2.1-flash` | `1K–4K` + `ratio`（tier）                      |
| `agnes-image-2.0-flash` | 精确 `WxH`（exact，代理把档位 + 比例折成像素） |

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
- Key 以明文存库，对外一律掩码为 `前 4 位…后 4 位`。
- 上游超时默认 300 秒，可在设置里调整为 60–360 秒；超时映射为 504。

## 尺寸与 n

- 客户端可传 Agnes 档位（`1K`–`4K`）或任意 `WxH`（含
  `auto`）。代理按面积与比例的对数距离折成最近的档位 + 比例，响应头 `X-Agnes-Resolved-Size: 2K 16:9`
  暴露结果，响应体 `size` 填 Agnes 原生输出像素。
- `size: "auto"` 只在参考图是上传文件或 Data URI 时读取文件头推算比例；参考图是 URL
  时**不发起任何外部请求**，退回 `1K + 1:1` 并在 `X-Agnes-Warnings` 里标记 `auto-size-from-url`。
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

  成功数为 0 时返回第一个子请求的错误信封与状态码。日志与用量严格一致：`requested` /
  `images`（成功数）/ `failed` / `ok = failed === 0`。

## 兼容字段

以下字段不生效，但不会报错；名字会出现在 `X-Agnes-Warnings` 里：
`quality`、`background`、`output_format`、`output_compression`、`moderation`、`style`、`input_fidelity`、`user`、`safety_identifier`，以及未知的顶层字段。

明确返回 400 的情况：`stream: true`、`partial_images`、`mask`、`file_id`、非 `image/png|jpeg|webp`
的上传、非 http(s)/data URI 的参考图 URL。

`image_param_mode`（设置项）控制参考图放在 `extra_body.image`（`nested`，默认）还是顶层
`image`（`top_level`）；`auto` 先发嵌套，编辑请求返回 400 时自动改用顶层重发一次，并在 10
分钟内记住可用的位置。`response_format` 始终放在 `extra_body` 内。

## 图片时间线与存储

- 每个成功生成并返回给客户端的输出图归档一行；参考输入图不入库。
- 上游给 `b64_json` 时直接解码为字节存 `BLOB`；上游给 URL 时在响应发出后下载（仅
  `https`、拒绝私网/回环与指向私网的重定向、上限 64 MiB / 60 秒）再入库。
- 下载或写库失败不影响客户端响应：gallery 行保留 `source_url` 且
  `archived=0`，控制台显示占位卡与原始链接。
- 时间线按 `id DESC` 分页（默认 24 张），按 UTC
  日期分组；单张删除与清空全部由用户在控制台决定，**没有自动保留上限**。BLOB 存在 Turso
  中，请留意数据库体积与费用。

## 已知取舍

- 请求体上限 32 MiB；单张输入图 20 MiB；最多 16 张。
- 代理不设输出体积预算、不按档位限制 `n`：极端组合（`4K × n=10 × Base64`）可能触及 isolate
  的内存上限，这是明确接受的取舍；上游限流错误原样返回（429）。
- 不实现 `mask` 局部重绘、不流式、不转码、不缩放；只存输出图，不提供图片编辑。
- 不伪造 `usage`；`revised_prompt` 固定为 `null`；上游未使用字段返回的空字符串一律归一化为 `null`。

## 上游实测结论（2026-11-20）

1. `extra_body.image` 与顶层 `image`、`extra_body.response_format` 与顶层 `response_format`
   都被接受；文档里“顶层会报错”没有复现。默认仍按文档使用嵌套，`auto` 回退只是保险。
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
- 归档下载只接受 Agnes 响应里给出的输出 URL，并校验
  `https`、私网/回环地址、重定向与体积上限；代理永不请求客户端提供的 URL。
- 密钥比较不泄漏长度与前缀；轮换 `PROXY_API_KEY` 会作废全部会话。
