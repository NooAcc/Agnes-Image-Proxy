# Agnes Image Proxy（Go + React）

把 Agnes 图像 API 包装成 OpenAI Images API 兼容层。服务使用 Go 1.26 单体运行，
管理控制台使用 React/TypeScript/Vite/Tailwind/shadcn/TanStack Query，构建产物通过
`go:embed` 打进同一个二进制；生产运行不需要 Node、Deno 或前端构建工具。

本项目面向**个人自用、自托管**，不提供多用户权限隔离。`PROXY_API_KEY` 同时拥有图片 API
和管理 API 权限，请勿将其作为“仅生成图片”的密钥分享给不受信任的人。

- 上游账号池：原子领取、失败冷却、成功 CAS 回写、逐账号尝试记录。
- 图片交付：生成后受控下载并同步保存原图到本地 `/data/images`；成功才返回本程序限时签名 URL 或原图 base64。
- 元数据富化：可选 Edge-Images `/api/batch` 服务，自动测量尺寸、生成缩略图并做五类 NSFW 分类；支持手动补齐。
- 控制台：总览、图库、账号、日志、设置五个页面，中文界面、深浅主题、键盘可访问。
- 单库：远程 Turso（libSQL）；数据库 schema 固定版本，不迁移旧库。

## 快速开始

### 离线预览（不消耗真实额度）

首次运行前必须构建前端，生成 Go 编译时嵌入的 `internal/webassets/dist/`：

```bash
npm --prefix frontend ci
npm --prefix frontend run build
go run ./cmd/agnes-proxy preview --port 8001
```

打开 `http://127.0.0.1:8001/admin`，管理密钥固定为 `preview`。预览使用临时 SQLite
数据库和本机模拟的 Agnes/Edge-Images 服务，含示例账号、日志、图库与补齐任务，不读取
生产环境变量、不连接 Turso、也不访问真实上游。原图、缩略图与 SQLite 均在隔离临时目录中，退出后一起删除。

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
PROXY_API_KEY=... TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... DATA_DIR="$PWD/.data" \
  go run ./cmd/agnes-proxy serve
```

不传子命令等价于 `serve`。

### Docker Compose

在 `compose.yaml` 的 `environment` 中填好三个必填值后运行：

```bash
docker compose up -d
```

Compose 直接拉取 `ghcr.io/nooacc/agnes-image-proxy:latest`，不再本地构建；更新镜像用
`docker compose pull && docker compose up -d`。数据以 `./data:/data` 绑定挂载，容器以
UID/GID 65532 运行。Compose 内置一次性的 `data-permissions` 服务（root busybox），在应用
启动前把 `./data` 归属改为 65532，因此首次部署无需手工 chown；手工创建目录时仍应保持该
归属。`restart: unless-stopped` 与 `stop_grace_period: 60s` 保留，后者是优雅退出宽限。
根文件系统只读、健康检查等由镜像自身提供。

### GHCR 镜像与自动构建

GitHub Actions 工作流 [`docker-publish.yml`](.github/workflows/docker-publish.yml)
使用仓库根目录的 Dockerfile 构建 `linux/amd64` 镜像，并发布到
`ghcr.io/nooacc/agnes-image-proxy`：

- 推送到 `main`：发布 `latest` 和 `sha-<短提交 SHA>`。
- 推送 `v*` 标签：发布原始标签、`sha-<短提交 SHA>`；符合语义版本的标签还会发布
  不带 `v` 的版本号（例如 `v1.2.3` 同时发布 `1.2.3`），不覆盖 `latest`。
- 向 `main` 提交 PR：仅验证镜像构建，不登录 GHCR、不推送镜像。
- 在 Actions 页面手动运行：选择 `main` 或 `v*` 标签时发布；其他分支只构建。

发布使用 GitHub 自动提供的 `GITHUB_TOKEN`（`contents: read`、`packages: write`），
无需额外添加 PAT 或仓库 Secret。构建使用 GitHub Actions 缓存，第三方 Actions
均固定到具体提交 SHA。

首次发布后，请在 GitHub 包设置中确认镜像包的可见性；**公开仓库不会自动使新建的
GHCR 包公开**。若需匿名拉取，将包可见性设为 Public，然后运行：

```bash
docker pull ghcr.io/nooacc/agnes-image-proxy:latest
docker run -d --name agnes-proxy --restart unless-stopped \
  --env-file .env -e DATA_DIR=/data -v agnes-image-data:/data -p 8000:8000 --read-only \
  --security-opt no-new-privileges:true --cap-drop ALL --stop-timeout 120 \
  ghcr.io/nooacc/agnes-image-proxy:latest
```

`compose.yaml` 直接使用上述 GHCR 镜像；本地构建请改用 `docker build -t agnes-image-proxy:local .`。

## 配置

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PROXY_API_KEY` | 是 | — | 同时作为数据面 Bearer 密钥与管理页登录密钥；只做恒定时间比较，不持久化明文以外的地方。 |
| `TURSO_DATABASE_URL` | 是 | — | `libsql://` 或 `https://`，不得带路径/查询/凭据。 |
| `TURSO_AUTH_TOKEN` | 是 | — | Turso token。 |
| `DATA_DIR` | 否 | `/data` | 可写绝对目录；所有应用图片存于 `images/` 子目录，启动检查可写性，配置为空白时报错。Compose 固定 `/data` 并绑定挂载 `./data`。 |
| `PORT` | 否 | `8000` | HTTP 监听端口。 |
| `CORS_ALLOWED_ORIGINS` | 否 | 空 | 逗号分隔的完整 origin，用于数据面 CORS。 |
| `TRUSTED_PROXY_CIDRS` | 否 | 空 | 可信反代网段。为空时完全忽略 `X-Forwarded-*`；仅可信来源的单值 `X-Forwarded-Proto/Host` 可用于推导 Cookie Secure 与同源判断。设置 `PUBLIC_ORIGIN` 后管理面不再需要此项。 |
| `PUBLIC_ORIGIN` | 否 | 空 | 固定公网 origin（如 `https://agnes.example.com`）。设置后管理面 Cookie 写操作只接受该 Origin，Cookie `Secure` 与图片链接默认地址也以它为准；管理面只能通过该 origin 访问。仅回环地址允许 http。 |
| `MAX_IN_FLIGHT` | 否 | `8` | 生成 → 下载 → 保存的全局在途子请求上限。 |
| `ARCHIVE_WORKERS` | 否 | `4` | 后台富化 worker 数量（变量名沿用）。 |
| `ARCHIVE_CAPACITY` | 否 | `32` | 请求级后台任务容量，必须 ≥ workers；满时新请求等待容量。 |
| `SHUTDOWN_TIMEOUT_SECONDS` | 否 | `120` | SIGTERM/SIGINT 优雅退出预算。 |

`PROXY_API_KEY` 轮换会让旧管理会话和旧图片签名链接失效；撤销管理会话不影响图片链接。密钥不会出现在日志、管理列表或错误响应中。

## 数据库与图片存储

当前 schema 为 **4**，不兼容 schema 1/2/3 和旧 Deno 数据；没有迁移或原图字段回退。
升级须使用空库，或**先停服**后显式重建。普通启动遇到非空旧库、版本不符时拒绝启动，
不会自动删除真实数据。首次启动空库会自动建表并写入 schema 标识，但**不会自动选择原图存储方式**。

### 首次初始化

空库启动后，使用 `PROXY_API_KEY` 登录 `/admin/setup`，必须明确选择一种原图存储方式：

- **本地存储（local）**：原图写入 `DATA_DIR/images`，需要为容器挂载持久化卷。
- **图床存储（imgbed）**：填写 CloudFlare ImgBed 站点根地址（HTTPS origin）与 API Token。
  Token 需要 `upload` 与 `delete` 权限；上传固定为不压缩、完整返回地址，目录为
  `agnes-image-proxy/YYYY-MM-DD`，日期按 UTC+8（中国标准时间）计算。

方式写入数据库后**不可切换**；初始化后的设置页只能更新图床地址与 Token（Token 留空表示保留）。
未初始化时，除会话、存储状态/初始化接口、静态控制台、健康检查和模型目录外，管理 API
与生成/编辑 API 一律返回 `503 initialization_required`，不会访问上游或写入图片。

图床相关约束：

- 图床应关闭文件自动过期；图床的公开链接不受本程序签名期限控制，也不能被本程序撤销。
- 上传后会回读并核对原图字节一致才发布图库；不自动重试上传，超时/崩溃可能留下孤立远端文件。
- 更换图床地址不会迁移文件；新地址必须已经存在同一套文件（相同路径），否则旧图不可读。
- 数据库明文保存图床 Token；数据库凭据与备份都属于敏感数据，需按包含密钥的资源保护。
- 本程序只删除图库登记过的远端文件；不递归清理 `agnes-image-proxy` 目录，也不清理孤立文件。

### 原图与数据库

- 原图定位统一存于 `original_ref`：local 模式为本地相对路径
  `DATA_DIR/images/<分片>/<随机publicID>/original.<扩展名>`；imgbed 模式为相对 file ID
  `agnes-image-proxy/YYYY-MM-DD/<文件名>`。数据库只保留定位、MIME、字节数和图库元数据。
  缩略图始终使用本地不可变版本文件，数据库保留同版本 BLOB 备份。
- 正常 GET/HEAD 只查询小型元数据；HEAD 验证原图存在与长度，不读完整原图。imgbed HEAD
  不发送 Token；远端文件真正不存在返回 404，权限、网络或内容不符属于存储不可用（503）。
  原图缺失不回源下载、不回退旧数据库内容或本地副本。`/data` 不作为静态目录公开，
  现有签名/管理鉴权不变。
- 原图发布前同步文件与目录项（Linux 容器部署）；Windows 非容器开发环境不承诺目录
  fsync 级掉电恢复，建议正式部署使用 Linux 持久化卷。
- **仅支持单实例**。本地卷或图床、Turso 数据库必须作为同一套数据备份、恢复。
  备份时停服，保持两侧同一时间点；多个独立磁盘实例不能共享同库。
- 留意磁盘空间。文件成功写入后才发布数据库记录；数据库超时/不确定提交会保留可能被引用
  的候选文件，不会覆盖已保存原图，可能留下孤立文件。本期没有后台垃圾回收。
- 单删会先删除原图，再删除数据库记录与本地缩略图；远端删除失败时保留记录和定位以便重试。
  清空图库按 id 升序逐页清理，某条失败会停止并返回 503，已清理的条目不会恢复；重试继续。
  清空是部分完成语义，UI 会提示可能只删除了部分图库。
  不删除 DATA_DIR 根目录里的无关文件，也不删除未登记的远端文件。

重建会清空**账号、设置、日志、图库、存储配置、本地应用图片文件，以及已登记的图床原图**
（破坏性，无旧图迁移）。schema 4 且已选 imgbed 时，先按数据库记录删除远端原图；任一删除
失败则命令失败，保留存储凭据与剩余记录，便于重试。重建后回到未初始化状态，可重新选择方式。
未被图库登记的远端孤立文件不会被追踪或删除，命令也不会声称已清理整个图床目录。

```bash
# 必须先停止运行中的 serve；提供三个必填变量和与 serve 相同的 DATA_DIR。
DATA_DIR="$PWD/.data" go run ./cmd/agnes-proxy reset-db --confirm
# Compose 部署：先停服，再使用相同数据库和图片卷重建
 docker compose stop agnes-proxy
 docker compose run --rm agnes-proxy reset-db --confirm
 docker compose up -d
```

**禁止在 serve 仍运行时执行 reset-db**：进程内图库锁不能协调另一个 CLI 进程。
不带 `--confirm` 会在读取配置、打开数据库、初始化图片目录之前失败。清空按图库记录先删除原图
（含本地版本文件）并删除记录，最后重建 schema；中途失败时命令会报错而不是声称完全清理，
但**已经删除的原图不会恢复**。`deep` 健康检查只执行 `SELECT 1`，不联系图床。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/images/generations` | JSON 文生图，也支持 JSON 内参考图。 |
| POST | `/v1/images/edits` | JSON 或 multipart 图生图/多图合成；不保留单数 `/edit` 别名。 |
| GET/HEAD/OPTIONS | `/v1/images/content/{publicID}` | 签名参数授权读取已保存原图；无需 Bearer/Cookie。 |
| GET | `/v1/models` | 静态模型目录；目录外模型仍原样转发。 |
| GET | `/health`、`/health?deep=1` | 存活 / 数据库就绪。 |
| GET | `/` | 302 到 `/admin`。 |

生成/编辑只接受 `Authorization: Bearer <PROXY_API_KEY>`，Cookie 不能调用生成 API。图片内容端点只接受 expires/signature，不接受 Bearer/Cookie 绕过签名。图片协议见
[`docs/api/images.openapi.yaml`](docs/api/images.openapi.yaml)。
管理 API 位于 `/admin/api/*`，接受会话 Cookie 或同一个 Bearer；文档见
[`docs/api/admin.openapi.yaml`](docs/api/admin.openapi.yaml)。管理面响应 `no-store`，
Cookie 变更请求校验 Origin，登录失败限速。

请求规则摘要：

- 默认 `response_format=url` 返回本程序签名地址；唯一另一选项 `b64_json` 为保存原图的标准带 padding base64。
  显式 `return_base64` 或 extra_body 格式控制参数返回 400 unsupported_parameter。Agnes 固定请求 URL。
- 支持 `1K`–`4K`、精确 `WxH`、`ratio` 与有参考图时的自动尺寸；显式尺寸仍校验参考图及签名，自动尺寸才解析参考图尺寸。
- 参考图最多 16 张、单张 20 MiB、请求体及规范化参考图列表 JSON 32 MiB；`mask`、`stream`、`partial_images`、`file_id` 不支持。
- 客户端 `n` 为正整数，上游始终按 `n=1` 逐子请求执行；并发上限是资源限制，不是协议 `n` 上限。
- 每个子请求最多尝试设置中的不同账号；部分成功返回 200 与成功图片；全失败按
  `429 > 504 > 502 > 503` 聚合，429 的 `Retry-After` 取较短值并封顶 900 秒。
- Succeeded/Failed 为子请求数（至少一张交付成功即 succeeded），两者合计 Requested；Images 为实际交付图片数。
  同一子请求仅保存部分输出也标记 partial-success；日志交付失败与账号尝试分开。账号成功表示 Agnes 成功，不因下游失败冷却。
- 响应头 `X-Agnes-Requested`、`X-Agnes-Succeeded`、`X-Agnes-Failed`、
  `X-Agnes-Resolved-Size`、`X-Agnes-Warnings`、`X-Agnes-Failure-Statuses`。
- 未认证请求不写日志；解析失败会记录 request/parse 日志。

## 图片链接与公开地址

- 设置“图片链接有效期（小时）” `imageUrlTtlHours` 默认 24，整数范围 1–720（最多30天）。
  TTL 从 HTTP 签发时开始，仅影响新链接；旧 expires 不会因设置改变而失效或延长。过期不删除原图。
- `imagePublicBaseUrl` 默认空，建议正式部署设置为 `https://images.example.com`。只接受外部 origin，
  不含路径、query、fragment 或凭据；仅 localhost/127.0.0.1/::1 允许 HTTP。设置后优先于
  `PUBLIC_ORIGIN`。
- 留空时优先使用 `PUBLIC_ORIGIN`，再根据请求 TLS 或可信反代的单值 X-Forwarded-Proto/Host
  推导；未受信任的头不使用，多值/逗号/非法 authority 拒绝。无法推导合法 HTTPS origin 时，
  生成前即400，不消耗 Agnes 额度。
- 例如 Docker 反代在 `10.20.0.0/24`，设置 `TRUSTED_PROXY_CIDRS=10.20.0.0/24`，代理发送
  `X-Forwarded-Proto: https`、`X-Forwarded-Host: images.example.com`；不要信任所有来源。
- 链接形如 `/v1/images/content/<32位随机publicID>?expires=<Unix秒>&signature=<base64url>`，
  独立领域 HMAC-SHA256，只授权这一张原图。到期边界 now >= expires，无效/过期/删除统一404。
- GET/HEAD 成功和错误均 no-store，HEAD只读元信息。删除/清空使链接立即失效，数字ID重用不会指向新图。
  **no-store 无法撤回已下载的副本**。管理员原图读取不受 TTL 影响。
- 有效本程序 URL 可再次作为参考图：精确匹配公开 origin，先验签，再从存储读取并展开为 Data URI，
  不向自己发 HTTP、不放宽外部参考图 SSRF；过期/篡改/已删除引用返回 image 参数400。

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
- Edge 优先 Agnes 源 URL，从不发送本程序签名 URL；尺寸同步 best-effort，仅请求 URL。
  后台缩略图/NSFW 在 URL fetch 失败后按需读取已有原图，最多一次 base64 重试，不再次保存。
- 所有实际内联项每批最多20项、decoded预算32MiB、JSON请求上限46MiB（含base64膨胀）。
  单张大于32MiB明确 failed source exceeds batch budget，大于50MiB为安全上限失败，均不发送；缩略图必须能被识别为 PNG/JPEG/WebP，且小于已知原图体积才保存。
- Edge-Images 必须在其侧允许访问两类域名：代理归档下载的**生成图片源域名**，以及
  富化时发送的**图库源 URL 域名**（包括你允许客户端传入的参考图托管域名）。代理本身
  不会替 Edge 做这项 allowlist 配置。

## 资源、并发与退出边界

- 每个有成功图片的客户端请求在发起上游调用前预留一份请求级富化容量；全部失败释放。
  容量、worker 与上游并发均为进程级资源限制。
- 富化队列限制任务数，不限制输出字节数。批量请求体、单图 base64、响应图片仍可能占用
  大量内存；服务不宣称队列使内存严格有界。
- SIGTERM/SIGINT：停止接收新请求与新容量预留 → 等待在途请求完成同步保存并提交富化 → 排空已接受
  富化任务（默认 120 秒）→ 关闭数据库。预算耗尽会取消生命周期 context 并在服务日志
  记录未完成任务数；进程被强杀或容器崩溃仍可能丢失内存中的未完成富化任务（已保存原图保留），本期不提供持久化
  任务队列。Docker 的 `stop_grace_period` 与预算一致。

## 管理控制台

`/admin/login` 输入 `PROXY_API_KEY` 登录。会话 Cookie 30 天有效，剩余不足 7 天时管理
API 会自动续期，总寿命不超过 90 天；设置页可撤销全部会话。深链接、刷新与前进/后退
均可用，筛选条件保存在 URL。

- 总览：UTC 日期范围、请求/成功/部分成功/失败/图片统计、两张单系列折线与逐日数据表、模型用量、账号健康。
- 图库：按 UTC 日期分组、24 项游标分页、tag 筛选、懒加载缩略图、原图弹窗/下载/删除/清空、补齐状态。
- 账号：脱敏 Key、启用/停用、探测、冷却重置、导入（同名 Key 不叠加额度）、删除。
- 日志：request/enrich 分类、逐账号尝试与 download/persist 交付失败详情、清空确认。
- 设置：上游与尺寸、超时/重试、图片服务参数、链接TTL/公开origin、撤销全部会话。

## 测试与验收

Go 检查同样需要嵌入前端产物；新 clone 或清理构建目录后，先安装依赖并构建前端：

```bash
npm --prefix frontend ci
npm --prefix frontend run build

gofmt -l internal cmd
go vet ./...
go test ./...                 # 离线；不访问真实 Turso/Agnes
go test -race ./...           # 工具链支持时

npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run test -- --run
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

## 许可证

本项目采用 [MIT License](LICENSE)，版权归 NooAcc 所有。第三方依赖及其包含的代码仍适用
各自的许可证；本项目许可证不替代第三方许可，也不授予 Agnes、Edge-Images 等外部服务、
模型或生成内容的权利。
