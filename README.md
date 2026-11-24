# Agnes Image Proxy（Go + React）

把 Agnes 图像 API 包装成 OpenAI Images API 兼容层。服务使用 Go 1.26 单体运行，
管理控制台使用 React/TypeScript/Vite/Tailwind/shadcn/TanStack Query，构建产物通过
`go:embed` 打进同一个二进制；生产运行不需要 Node、Deno 或前端构建工具。

- 上游账号池：原子领取、失败冷却、成功 CAS 回写、逐账号尝试记录。
- 图片归档：原图与缩略图存数据库 BLOB，URL 在响应后受控下载；失败保留源链接。
- 元数据富化：可选 Edge-Images `/api/batch` 服务，自动测量尺寸、生成缩略图并做五类 NSFW 分类；支持手动补齐。
- 控制台：总览、图库、账号、日志、设置五个页面，中文界面、深浅主题、键盘可访问。
- 单库：远程 Turso（libSQL）；数据库 schema 固定版本，不迁移旧库。

## 快速开始

### 离线预览（不消耗真实额度）

```bash
npm --prefix frontend ci
go run ./cmd/agnes-proxy preview --port 8001
```

打开 `http://127.0.0.1:8001/admin`，管理密钥固定为 `preview`。预览使用临时 SQLite
数据库和本机模拟的 Agnes/Edge-Images 服务，含示例账号、日志、图库与补齐任务，不读取
生产环境变量、不连接 Turso、也不访问真实上游。退出后临时数据库删除。

### 本地开发

先构建一次前端，Go 才能嵌入 `internal/webassets/dist/`（没有空白占位回退）：

```bash
npm --prefix frontend ci
npm --prefix frontend run build
go run ./cmd/agnes-proxy preview --port 8000
```

Vite 开发服务器（`npm --prefix frontend run dev`，端口 5173）会把 `/admin/api`、`/v1`
与 `/health` 代理到 `http://127.0.0.1:8000`，因此可以在另一个终端用上面的 preview
作为后端。生产模式需要真实环境变量：

```bash
PROXY_API_KEY=... TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... \
  go run ./cmd/agnes-proxy serve
```

不传子命令等价于 `serve`。

### Docker Compose

```bash
cp .env.example .env      # 填入三个必填值
docker compose up -d --build
```

镜像为多阶段构建：Node 24 构建前端 → Go 1.26 以 `CGO_ENABLED=0` 编译 Linux 二进制 →
distroless 非 root 运行镜像（仅含二进制与 CA）。Compose 只启动 `agnes-proxy`，映射
`8000`，`restart: unless-stopped`、`stop_grace_period: 120s`、只读根文件系统、健康检查
调用二进制自带的 `healthcheck`。没有数据卷，也不需要 SQLite sidecar。

## 配置

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PROXY_API_KEY` | 是 | — | 同时作为数据面 Bearer 密钥与管理页登录密钥；只做恒定时间比较，不持久化明文以外的地方。 |
| `TURSO_DATABASE_URL` | 是 | — | `libsql://` 或 `https://`，不得带路径/查询/凭据。 |
| `TURSO_AUTH_TOKEN` | 是 | — | Turso token。 |
| `PORT` | 否 | `8000` | HTTP 监听端口。 |
| `CORS_ALLOWED_ORIGINS` | 否 | 空 | 逗号分隔的完整 origin，用于数据面 CORS。 |
| `TRUSTED_PROXY_CIDRS` | 否 | 空 | 可信反代网段。为空时完全忽略 `X-Forwarded-*`；仅可信来源的单值 `X-Forwarded-Proto/Host` 可用于推导 Cookie Secure 与同源判断。 |
| `MAX_IN_FLIGHT` | 否 | `8` | 上游全局在途请求上限。 |
| `ARCHIVE_WORKERS` | 否 | `4` | 归档 worker 数量。 |
| `ARCHIVE_CAPACITY` | 否 | `32` | 请求级后台任务容量，必须 ≥ workers；满时新请求等待容量。 |
| `SHUTDOWN_TIMEOUT_SECONDS` | 否 | `120` | SIGTERM/SIGINT 优雅退出预算。 |

`PROXY_API_KEY` 轮换会让旧管理会话失效。密钥不会出现在日志、管理列表或错误响应中。

## 数据库

Turso 需要一个**空的**新库。首次启动自动建表并写入 schema 标识；如果库非空、版本不符
或来自旧 Deno 实现，服务会拒绝启动，不会自动迁移、改表或读取旧数据。

重建（破坏性，删除本应用的全部表并重新建空 schema）：

```bash
go run ./cmd/agnes-proxy reset-db --confirm     # 先提供三个必填环境变量
# 或
docker compose run --rm agnes-proxy reset-db --confirm
```

不带 `--confirm` 会在打开数据库连接之前失败。`deep` 健康检查只执行 `SELECT 1`。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/images/generations` | JSON 文生图，也支持 JSON 内参考图。 |
| POST | `/v1/images/edits` | JSON 或 multipart 图生图/多图合成；不保留单数 `/edit` 别名。 |
| GET | `/v1/models` | 静态模型目录；目录外模型仍原样转发。 |
| GET | `/health`、`/health?deep=1` | 存活 / 数据库就绪。 |
| GET | `/` | 302 到 `/admin`。 |

数据面只接受 `Authorization: Bearer <PROXY_API_KEY>`，Cookie 永远不能调用图片 API。
管理 API 位于 `/admin/api/*`，接受会话 Cookie 或同一个 Bearer；文档见
[`docs/api/admin.openapi.yaml`](docs/api/admin.openapi.yaml)。管理面响应 `no-store`，
Cookie 变更请求校验 Origin，登录失败限速。

请求规则摘要：

- 默认返回 `url`；`response_format=b64_json` 或 `return_base64=true` 请求 base64。
- 支持 `1K`–`4K`、精确 `WxH`、`ratio` 与有参考图时的自动尺寸；显式尺寸不读取参考图。
- 参考图最多 16 张、单张 20 MiB、请求体 32 MiB；`mask`、`stream`、`partial_images`、`file_id` 不支持。
- 客户端 `n` 为正整数，上游始终按 `n=1` 逐子请求执行；并发上限是资源限制，不是协议 `n` 上限。
- 每个子请求最多尝试设置中的不同账号；部分成功返回 200 与成功图片；全失败按
  `429 > 504 > 502 > 503` 聚合，429 的 `Retry-After` 取较短值并封顶 900 秒。
- 响应头 `X-Agnes-Requested`、`X-Agnes-Succeeded`、`X-Agnes-Failed`、
  `X-Agnes-Resolved-Size`、`X-Agnes-Warnings`、`X-Agnes-Failure-Statuses`。
- 未认证请求不写日志；解析失败会记录 request/parse 日志。

## 外部图片服务（Edge-Images）契约

设置页的“图片服务地址”为空即关闭测量、缩略图与 NSFW 富化。配置后代理只调用
`POST {base}/api/batch`，请求体是顶层数组，每批最多 20 项：

```json
[
  {
    "uuid": "0",
    "url": "https://source.example/image.png",
    "params": { "format": "json" }
  }
]
```

富化时 `params` 为 `{ "width": 640, "height": 640, "crop": "none", "size": "down",
"format": "webp", "quality": 75, "nsfw": 1 }`；没有可用 URL 时发送 `base64` 与
`contentType`。响应是按 `uuid` 索引的对象：

```json
{
  "0": {
    "success": true,
    "data": {
      "width": 1024,
      "height": 1024,
      "format": "png",
      "sourceContentType": "image/png",
      "base64": "<缩略图>",
      "nsfw": {
        "drawing": 0.01, "hentai": 0.01, "safe": 0.95,
        "porn": 0.01, "sexy": 0.02, "isNsfw": false
      }
    }
  }
}
```

- 测量读取 `width/height/format`；富化读取 `nsfw` 五分类与 `isNsfw`，最高分生成 tag，
  并列按 safe/drawing/sexy/porn/hentai 顺序；`base64` 是可选的缩略图。
- URL 失败且本地有原图时只重试一次 base64。内联源每批预算 32 MiB，单张超过 50 MiB
  不发送；缩略图必须能被识别为 PNG/JPEG/WebP，且小于已知原图体积才保存。
- Edge-Images 必须在其侧允许访问两类域名：代理归档下载的**生成图片源域名**，以及
  富化时发送的**图库源 URL 域名**（包括你允许客户端传入的参考图托管域名）。代理本身
  不会替 Edge 做这项 allowlist 配置。

## 资源、并发与退出边界

- 每个有成功图片的客户端请求在发起上游调用前预留一份请求级归档容量；全部失败释放。
  容量、worker 与上游并发均为进程级资源限制。
- 归档队列限制任务数，不限制输出字节数。批量请求体、单图 base64、响应图片仍可能占用
  大量内存；服务不宣称队列使内存严格有界。
- SIGTERM/SIGINT：停止接收新请求与新容量预留 → 等待在途请求提交归档 → 排空已接受
  归档任务（默认 120 秒）→ 关闭数据库。预算耗尽会取消生命周期 context 并在服务日志
  记录未完成任务数；进程被强杀或容器崩溃仍可能丢失内存中的未归档任务，本期不提供持久化
  任务队列。Docker 的 `stop_grace_period` 与预算一致。

## 管理控制台

`/admin/login` 输入 `PROXY_API_KEY` 登录。会话 Cookie 30 天有效，剩余不足 7 天时管理
API 会自动续期，总寿命不超过 90 天；设置页可撤销全部会话。深链接、刷新与前进/后退
均可用，筛选条件保存在 URL。

- 总览：UTC 日期范围、请求/成功/部分成功/失败/图片统计、两张单系列折线与逐日数据表、模型用量、账号健康。
- 图库：按 UTC 日期分组、24 项游标分页、tag 筛选、懒加载缩略图、原图弹窗/下载/删除/清空、补齐状态。
- 账号：脱敏 Key、启用/停用、探测、冷却重置、导入（同名 Key 不叠加额度）、删除。
- 日志：request/enrich 分类、逐账号尝试详情、清空确认。
- 设置：上游与尺寸、超时/重试、图片服务参数、撤销全部会话。

## 测试与验收

```bash
gofmt -l internal cmd
go vet ./...
go test ./...                 # 离线；不访问真实 Turso/Agnes
go test -race ./...           # 工具链支持时

npm --prefix frontend ci
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run test -- --run
npm --prefix frontend run build
npm --prefix frontend run test:e2e
```

E2E 会构建前端与 Go 二进制并启动 `preview --port 8123`，使用系统 Chrome
（Playwright `channel: "chrome"`）执行登录、五页面、CRUD、模拟生成/编辑、下载、
补齐轮询、会话撤销与 axe 扫描；如本机没有 Chrome，请安装 Chrome 或按需调整
`frontend/playwright.config.ts`。截图输出在 `frontend/test-results/screenshots/`。

Linux 无 CGO 编译检查：

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o .build/agnes-proxy ./cmd/agnes-proxy
```

## 非目标

不迁移旧数据库、不兼容旧内部路由/DTO、不在生产运行 Deno/Node、不做模型名映射、
不支持 mask/流式输出、不做本地图片转码/缩放、不提供自动图库清理或分布式任务服务。
