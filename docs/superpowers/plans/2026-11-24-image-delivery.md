# URL/base64 统一图片交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agnes 固定返回源 URL，代理保存原图后按客户端要求交付自身的限时签名 URL 或 base64，同时保留 Edge-Images 的测量与富化能力。

**Architecture:** 将账号池生成、受控下载与同步原图保存放在同一个有界子请求流程中，客户端格式仅影响最后的响应序列化。图片签名访问与管理认证分离；后台任务只携带已保存图库 ID，Edge 优先读取 Agnes URL，必要时按需加载原图进行一次 base64 重试。

**Tech Stack:** Go 1.26.1、net/http、标准库 HMAC-SHA256、Turso/libSQL、modernc SQLite 离线测试；React 19、TypeScript、Vite、TanStack Query、Zod、现有 Tailwind/shadcn 表单；Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-24-image-delivery-design.md`

## Global Constraints

- 本计划仅为待执行文档；用户本轮要求首先完成计划，不代表授权开始实现、提交或发布。
- 沿用 Go + React、Turso/libSQL 原图 BLOB 存储、现有账号池和受控下载器。不引入对象存储、Docker 文件卷、图片处理库、持久化任务队列或新的外部服务。
- Agnes 固定请求 URL 输出，与客户端返回格式解耦；保留 nested/top_level 两种参考图参数位置。
- 客户端唯一输出参数 `response_format`：默认 `url`，可选 `b64_json`；明确拒绝客户端 `return_base64` 别名和 extra_body 中的格式控制参数。
- 任何返回成功的图片均已经存在于图库原图存储；base64 与保存的原图逐字节一致，不缩放、不转码。
- 客户端 URL 指向本程序原图；默认 TTL 为一天，`imageUrlTtlHours` 为整数小时，默认 24，可选 1–720（最多 30 天）。
- `imagePublicBaseUrl` 默认空，只接受外部 origin，不接受路径、查询、片段、凭据；仅本地回环可用 HTTP。空值沿用现有可信反代规则推导 origin。
- 原图下载上限 64 MiB；参考图最多 16 张、单图 20 MiB、请求体及规范化参考图预算 32 MiB；不取消 SSRF、重定向、体积、超时与并发边界。
- Edge-Images 继续负责尺寸测量、缩略图与 NSFW；尺寸同步 best-effort，缩略图/NSFW 后台；优先 Agnes 源 URL，不把代理签名 URL 作为 Edge 图片来源。
- 签名采用独立领域标记的 HMAC-SHA256，publicID 随机至少 128 bit；`now >= expires` 无效；图片端点成功和错误均 `Cache-Control: no-store`。
- 全失败聚合优先级保持 `429 > 504 > 502 > 503`；下游失败不得触发账号冷却或再次生成。
- 不兼容旧代码或旧数据，不增加迁移、旧字段映射或多格式兜底分支。schema 版本由 `1` 升到 `2`，旧库拒绝启动；不得擅自执行真实 reset-db。
- 不提交、不推送、不创建 PR；每任务检查点以 diff 和测试代替自动 commit。未来用户明确要求提交时，才创建非 main 分支并提交。
- 先使用 CodeGraph 理解待改符号；图谱返回源视为已读；文档、配置及未覆盖片段再使用 Read/Grep。
- 测试只访问临时 SQLite 与本地 mock；真实 Agnes/Turso/Edge 未经另行授权不访问，不声称已验证真实上游。

## Review Focus

1. 远程数据库写超时后可能实际已提交：同一输出再次保存不得产生第二份原图或再次生成（Task 1、4）。
2. 本程序 URL 被用作参考图，但其域名并非自己的 origin：不得仅凭相同路径把第三方 URL 解释为本地访问授权（Task 3、8）。
3. 一个 Agnes 子请求返回多张图片且只有部分保存成功：图片数、子请求数、partial-success 与每日用量必须使用各自正确单位（Task 5）。
4. 用户在富化期间删除图片或清空图库：后台任务不得重建原图，旧签名 URL 不得指向重用数字 ID 的新图片（Task 1、3、6）。
5. 客户端取消、响应写失败或 SIGTERM 与同步持久化相遇：保存成功的图片保留，后台任务预留恰好提交/释放一次（Task 5、7）。

---

## 文件与责任地图

当前基线：分支 main，只有 `.codegraph/` 与设计文档未跟踪；已运行 images/agnes/service/store/httpapi 五包测试，通过但使用缓存。实施时重新运行基线，不把这个结果当作新功能证据。

| 文件 | 责任与计划动作 |
| --- | --- |
| `internal/domain/settings.go` | 增加 TTL、公网 origin 配置及严格校验 |
| `internal/domain/gallery.go` | 定义保存后图片标识/元信息，插入输出幂等键 |
| `internal/domain/logs_types.go`、`internal/domain/logs.go` | 增加交付失败摘要和明确的 partial 标记 |
| `internal/store/schema.go` | schema v2、随机 publicID/幂等键唯一约束、交付日志字段 |
| `internal/store/gallery.go` | 保留管理图库读写，新增同步保存和按 publicID/元信息读取 |
| `internal/store/image_content.go`（新） | publicID 与数字 ID 的原图元信息/正文查询 |
| `internal/store/logs.go` | 持久化失败摘要与 partial，正确更新每日用量 |
| `internal/auth/image_links.go`（新） | 与管理会话分离的图片 HMAC 签发、校验 |
| `internal/httpapi/image_origin.go`（新） | 严格 origin 构造，复用可信反代判断 |
| `internal/httpapi/image_content.go`（新） | GET/HEAD 签名内容端点、CORS、缓存和错误 |
| `internal/images/normalize.go`、`parse.go`、`multipart.go`、`dimensions.go` | 固定 URL 上游适配、唯一格式入口、统一参考图检查 |
| `internal/images/remote.go` | 可分类下载错误、保留 SSRF 与体积限制 |
| `internal/service/delivery.go`（新） | 单图片下载、有限重试、同步持久化、可选一次 base64 编码 |
| `internal/service/images.go` | 有界调度和交付聚合，输出保存后元信息，不在这里签 URL |
| `internal/service/enrichment_job.go`（新） | 仅对已有图库 ID 执行后台富化，不再次保存 |
| `internal/service/edge.go`、`enrich.go`、`metadata.go` | Edge 按需原图加载、实际内联预算、保留 URL 测量 |
| `internal/service/backfill.go`、`tasks.go` | 同一富化边界与生命周期，避免预读整张 BLOB |
| `internal/service/archive.go` | Task 6 删除，原职责分为同步 delivery 与后台 enrichment job |
| `internal/httpapi/local_reference.go`（新） | 验证自己签发 URL、展开本地原图，不绕过 SSRF |
| `internal/httpapi/router.go`、`internal/app/runtime.go` | 组装服务、签名响应、参考图闭环 |
| `internal/preview/preview.go` | URL-only mock 和新图库字段、离线端到端验收 |
| `frontend/src/lib/schemas.ts`、`frontend/src/test/handlers.ts` | 同步 settings/log DTO 与测试数据 |
| `frontend/src/features/settings/settings-page.tsx` | TTL/公网地址表单，沿用现有布局 |
| `frontend/src/features/logs/logs-page.tsx` | 交付失败可观察性，不混入账号尝试列表 |
| `frontend/src/features/gallery/image-dialog.tsx` | 正确文件后缀，由服务器决定下载名称 |
| `docs/api/admin.openapi.yaml`、`docs/api/images.openapi.yaml`（新）、`README.md` | 新字段、签名访问和部署/重建说明 |

不按前后端拆成独立项目：它们共用新 settings/log/gallery 契约，只有整条图片交付链路才能满足需求。以下任务按可独立审查的边界顺序执行；基础任务可单独测试，HTTP 交付集成由 Task 7 收口。

## 公共接口约定

所有类型位于本节指定文件；后续任务引用时不得另起同义类型。未列出的私有帮助函数由实施者按现有风格命名。

```go
// internal/domain/gallery.go
// PublicID: crypto/rand 16 bytes -> 32 lowercase hex characters.
type StoredImage struct {
    ID int64
    PublicID string
    MIME string
    Bytes int64
}
// GalleryInsert 增加 OutputKey string；同一执行输出稳定唯一，非空。
// key = requestID + ":" + decimal(subrequestIndex) + ":" + decimal(imageIndex).

// internal/domain/logs.go
type DeliveryFailure struct {
    SubrequestIndex int64 `json:"subrequestIndex"`
    ImageIndex int `json:"imageIndex"`
    Stage string `json:"stage"` // download, persist
    Status int `json:"status"`
    Code string `json:"code"`
}
// RequestLog 增加 Partial bool `json:"partial"`、
// DeliveryFailures []DeliveryFailure `json:"deliveryFailures"`。

// internal/store/gallery.go
func (s *Store) SaveGeneratedImage(ctx context.Context, in domain.GalleryInsert) (domain.StoredImage, error)
// InsertGallery(ctx, in) (int64, error) 仍供 seed/普通插入使用，但共享插入实现。
// 两者均生成随机 publicID；OutputKey 冲突返回同一已保存图片，不写第二份 BLOB。

// internal/store/image_content.go
func (s *Store) ImageInfo(ctx context.Context, id int64) (domain.StoredImage, error)
func (s *Store) PublicImageInfo(ctx context.Context, publicID string) (domain.StoredImage, error)
func (s *Store) PublicImageContent(ctx context.Context, publicID string) ([]byte, string, error)
// 原有 GalleryContent(ctx, id, thumbnail) ([]byte, string, error) 保留。

// internal/auth/image_links.go
type ImageLinkClaims struct { PublicID string; ExpiresAt time.Time }
func NewImageLinks(apiKey string, now func() time.Time) *ImageLinks
func (s *ImageLinks) Issue(baseURL, publicID string, ttl time.Duration) (string, error)
func (s *ImageLinks) Verify(publicID string, query url.Values) (ImageLinkClaims, error)
var ErrInvalidImageLink error

// internal/service/delivery.go
type DeliveryStore interface {
    SaveGeneratedImage(context.Context, domain.GalleryInsert) (domain.StoredImage, error)
}
type DeliveryInput struct {
    RequestID string
    SubrequestIndex int64
    ImageIndex int
    Model, Prompt, ExpectedSize, SourceURL string
    AccountID int64
    AccountName string
    Measurement domain.Measurement
    IncludeBase64 bool
}
type DeliveredImage struct {
    Stored domain.StoredImage
    SourceURL string
    Base64 *string // only for b64_json client; never carried in background jobs
    Measurement domain.Measurement
}
type DeliveryOptions struct { Store DeliveryStore; Downloader Downloader }
func NewDelivery(options DeliveryOptions) *Delivery
func (d *Delivery) Deliver(ctx context.Context, in DeliveryInput) (DeliveredImage, error)
type DeliveryRunner interface {
    Deliver(context.Context, DeliveryInput) (DeliveredImage, error)
}

// internal/service/images.go (Task 5)
type MeasurementWriter interface {
    SetImageMeasurement(context.Context, int64, domain.Measurement) error
}
// internal/store/gallery.go (Task 5)
func (s *Store) SetImageMeasurement(ctx context.Context, id int64, measurement domain.Measurement) error

// internal/service/enrichment_job.go
type EnrichmentJob struct {
    RequestID, Endpoint, Model string
    IDs []int64
    Settings domain.Settings
}
type EnrichmentJobRunner interface {
    Run(context.Context, EnrichmentJob) error
}
type EnrichmentJobStore interface {
    GalleryEnrichState(context.Context, int64) (string, domain.GallerySource, bool, error)
    RecordEnrichment(context.Context, domain.RequestLog) error
}
type EnrichmentJobOptions struct {
    Store EnrichmentJobStore; Enricher Enricher; Locks *GalleryLocks
    Now func() time.Time; Logf func(string, ...any)
}
func NewEnrichmentJobs(options EnrichmentJobOptions) *EnrichmentJobs
func (j *EnrichmentJobs) Run(ctx context.Context, job EnrichmentJob) error

// internal/service/edge.go
type OriginalReader interface {
    GalleryContent(context.Context, int64, bool) ([]byte, string, error)
}
func (e *Edge) WithOriginalReader(reader OriginalReader) *Edge

// internal/httpapi/local_reference.go
type LocalReferenceStore interface {
    PublicImageInfo(context.Context, string) (domain.StoredImage, error)
    PublicImageContent(context.Context, string) ([]byte, string, error)
}
func NewLocalReferences(baseURL string, signer *auth.ImageLinks, store LocalReferenceStore, fallback images.ReferenceReader) *LocalReferences
func (r *LocalReferences) ResolveReference(ctx context.Context, source string) (string, error)
func (r *LocalReferences) Dimensions(ctx context.Context, source string) (domain.PixelSize, error)
// 同一 HTTP 请求内缓存已读取的本地 Data URI/尺寸；不跨请求缓存未授权内容。
```

---

### Task 1: 建立 settings、图片标识与日志存储契约

**Files:**
- Modify: `internal/domain/settings.go:13-104`、`internal/domain/gallery.go`、`internal/domain/logs.go`、`internal/domain/logs_types.go`
- Modify: `internal/store/schema.go:15-143`、`internal/store/settings.go`、`internal/store/gallery.go:26-80`、`internal/store/logs.go`、`internal/httpapi/settings.go`
- Create: `internal/store/image_content.go`、`internal/store/image_content_test.go`
- Test: `internal/domain/settings_test.go`、`internal/domain/settings_validate_test.go`、`internal/store/schema_test.go`、`internal/store/settings_test.go`、`internal/store/logs_gallery_test.go`
- Modify: `internal/httpapi/testdata/admin-contracts.json`、`frontend/src/lib/schemas.ts`、`frontend/src/test/handlers.ts`、`docs/api/admin.openapi.yaml`（同一任务同步契约，不能留下后端新增字段导致前端无法解码）

**Interfaces:**
- Consumes: 现有 `GalleryInsert`、`RequestLog`、`Store.operation`、`classifyDBError`。
- Produces: 公共接口中的 `StoredImage`、`DeliveryFailure`、`SaveGeneratedImage`、`ImageInfo`、`PublicImageInfo`、`PublicImageContent`；两项新 settings 字段；schema v2。

- [ ] **Step 1: 写新契约失败测试。** `TestImageLinkSettings` 断言默认 24/空 origin，1 与 720 合法，0/721/负数不合法；settings JSON 小数/字符串拒绝；公网 origin 路径、query、fragment、user、非回环 HTTP 拒绝，HTTPS/回环 HTTP 可用。`TestPublicImageIdentity` 保存 PNG，断言 `len(PublicID)==32`、bytes/MIME 正确且可查询。`TestSaveGeneratedImageIdempotent` 同一 OutputKey 保存两次，断言相同 ID/publicID，表中只有一行。
- [ ] **Step 2: 运行失败测试。** `go test ./internal/domain ./internal/store -run 'Test(ImageLinkSettings|PublicImageIdentity|SaveGeneratedImageIdempotent)' -count=1`；预期字段/方法不存在或新值断言失败，而非环境故障。
- [ ] **Step 3: 实现 settings 与 schema v2。** 增加 `ImageURLTTLHours int`/`ImagePublicBaseURL string` 的 JSON 名分别为 `imageUrlTtlHours`/`imagePublicBaseUrl`。gallery 添加 `public_id TEXT NOT NULL UNIQUE`、`output_key TEXT NOT NULL UNIQUE`；request_logs 添加 `partial INTEGER NOT NULL`、`delivery_failures TEXT NOT NULL`。新 schema 不做旧库迁移。settings HTTP PUT 与存储JSON解码必须显式检查两项新键是否存在（包括允许空值的imagePublicBaseUrl），拒绝缺字段而非只依靠Go零值校验。公开 origin 校验区别于 service URL：不允许路径，合法尾斜杠仅规范化为 origin。严格新库设置，不读取时补旧字段。
- [ ] **Step 4: 实现保存与查询接口。** 生成 publicID 失败必须返回错误，禁止时间戳/数字 ID 兜底。`SaveGeneratedImage` 只接受有效 MIME/非空原图和 OutputKey；共享 insert/query，使用 OutputKey 唯一约束原子去重。对可能已提交的同 key 重试返回已保存元信息，不覆盖原图。`InsertGallery` 的现有 seed/测试调用全部提供非空稳定 OutputKey；临时旧 archive 调用提供 request/index key，Task 6 删除它。HEAD 用查询元信息接口，禁止先读取整个 BLOB。
- [ ] **Step 5: 写并实现存储边界测试。** `TestPublicIDAfterClearAndNumericIDReuse`：清空后新图数字 ID 可重用，但 publicID 不同且旧 publicID 404。`TestPublicInfoDoesNotSelectBlob` 用独立查询边界断言 metadata 查询不包含 image 列；并发同 OutputKey 只创建一行。日志 round-trip `deliveryFailures` 非 null、`partial=true` 且 `Failed=0` 时仍计入每日 partial；无故障旧请求 DTO 仍输出空数组/false，不靠缺字段兼容。
- [ ] **Step 6: 同步所有 settings/log DTO fixture、Zod 与 OpenAPI。** `partial`、`deliveryFailures` 必填，`imageUrlTtlHours` 必填整数 1–720，`imagePublicBaseUrl` 必填字符串但可空；更新预览 seed、Go 字段精确测试、前端 makeSettings/makeLog，不更改页面布局。
- [ ] **Step 7: 验证契约检查点。** `go test ./internal/domain ./internal/store ./internal/httpapi -count=1`；`npm --prefix frontend run test -- --run src/lib/schemas.test.ts`；`npm --prefix frontend run typecheck`；预期全部 PASS，`git diff --check` 无错误；记录结果，不 commit。

### Task 2: 固定 Agnes URL 契约并收敛客户端格式参数

**Files:**
- Modify: `internal/images/normalize.go:10-105`、`internal/images/parse.go:102-155,376-397`、`internal/images/multipart.go:122-156`
- Test: `internal/images/normalize_test.go`、`internal/images/parse_test.go`、`internal/agnes/pool_test.go`

**Interfaces:**
- Consumes: `domain.ImageRequest`、现有 `Payload(req, mode)`、`Normalize(raw)`。
- Produces: 签名不变的 Payload/Normalize，但上游恒定 URL；客户端格式只留下 `ImageRequest.ResponseFormat`。

- [ ] **Step 1: 写失败测试 `TestPayloadAlwaysRequestsURL`。** 表驱动覆盖客户端 url/b64_json × 有/无参考图 × nested/top_level；全部断言 `extra_body.response_format == "url"`、没有顶层/嵌套 return_base64、n=1；仅参考图位置变化。`TestClientFormatHasSingleEntry`：JSON/multipart 的 return_base64=true/false 均 400 unsupported_parameter；extra_body.response_format/return_base64 明确拒绝；正常 response_format 默认 url，可选 b64_json，非法值 400。
- [ ] **Step 2: 运行 RED。** `go test ./internal/images -run 'Test(PayloadAlwaysRequestsURL|ClientFormatHasSingleEntry)' -count=1`；预期旧格式分支/别名被测试击中。
- [ ] **Step 3: 实现唯一格式入口与固定 URL 适配。** Payload 保留参考图 nested/top_level 配置，不按客户端格式分支；顶层 return_base64 永不出现。readResponseFormat 只读取 response_format；rejectUnsupported/buildRequest 对 extra_body 格式字段明确报错，错误归属正确字段。不要删除 reservedExtraKeys 的保护作用。
- [ ] **Step 4: 写并实现 `TestNormalizeURLContract`。** HTTPS 绝对无凭据 URL 正常，空/空白、非 URL、javascript/data scheme、凭据 URL、仅 b64_json 的输出均 502 invalid_upstream_response；同项同时含有效 url 与 b64_json 时仅提取 URL，不解码 base64。loopback HTTP 只允许已有预览上游来源（localhost/127.0.0.1/::1），生产 Remote.Download 仍拒绝 HTTP。不在 Normalize 发网络请求。更新之前用 `aGk=` 视为成功的测试。
- [ ] **Step 5: 验证。** `go test ./internal/images ./internal/agnes -count=1`；现有 failover/validation 行为保持。domain.OutputImage.Base64 暂仅供尚未删除的 archive/Edge 旧调用编译，Task 6 完全删除，不在完成态保留兜底。`git diff --check` 通过；不 commit。

### Task 3: 图片链接签名与可信公网 origin

**Files:**
- Create: `internal/auth/image_links.go`、`internal/auth/image_links_test.go`
- Create: `internal/httpapi/image_origin.go`、`internal/httpapi/image_origin_test.go`
- Reference: `internal/httpapi/middleware.go`、`internal/httpapi/auth.go`（复用信任判断，不改变管理会话）

**Interfaces:**
- Consumes: Task 1 settings、现有 `externalScheme/externalHost/isTrustedProxy`。
- Produces: 公共接口中的 ImageLinks；`func (a *Auth) ImageOrigin(req *http.Request, settings domain.Settings) (string, error)`。

- [ ] **Step 1: 写 `TestImageLinksExpiryAndTampering`。** 可注入时钟为 2026-11-24 00:00:00 UTC；签发 24h，assert expires=now+86400 秒；到期前一秒通过、到期时失败；publicID/expiry/signature 替换、错误根密钥、管理 session token 全部拒绝。
- [ ] **Step 2: 运行 RED。** `go test ./internal/auth ./internal/httpapi -run 'Test(ImageLinks|ImageOrigin)' -count=1`；预期新 API 不存在。
- [ ] **Step 3: 实现签名。** `Issue` 构造 `/v1/images/content/{publicID}`，只带 expires/signature；publicID 必须为 32 位小写 hex。签名输入固定为 `agnes:image-content:v1\n{publicID}\n{expires}`，用 PROXY_API_KEY 做 HMAC-SHA256，signature 为不带 padding 的 base64url。Verify 要求恰好两个已知 query 键且各仅一个值；expiry 为正的规范十进制秒，拒绝前导零、+、溢出、非数字；signature 解码恰好 32 bytes、hmac.Equal；所有拒绝返回 ErrInvalidImageLink。TTL 校验为 1–720h，不拿当前 settings 重新解释旧 expires。
- [ ] **Step 4: 写并实现 origin 边界。** `TestImageOrigin` 覆盖显式公网地址优先、直连 HTTPS/本地 HTTP、可信代理的单值转发头、非可信转发头不采用、多个 Host/Proto/逗号值拒绝。`TestImageOriginRejectsAmbiguousAuthority` 覆盖 scheme/user/path/control 字符污染 Host、非回环 HTTP，验证返回可分类 400 而非签出无效链接。默认空地址生产必须提供可推导 HTTPS origin 或配置公开地址。
- [ ] **Step 5: 写 `TestImageLinksTTLUpdateAndRotation`。** 旧 24h 链接不因 settings 改为 1h 而失效/延长；新链接 expires=now+3600；密钥轮换旧链接失败；管理 session revoke 不影响图片链接。
- [ ] **Step 6: 验证。** `go test ./internal/auth ./internal/httpapi -count=1`，`git diff --check`；检查签名使用专用领域且不写日志。无 commit。

### Task 4: 单图片同步交付与有限下载重试

**Files:**
- Create: `internal/service/delivery.go`、`internal/service/delivery_test.go`
- Modify: `internal/images/remote.go:126-165`
- Test: `internal/images/remote_test.go`（保留 DNS rebinding/private redirect/体积测试）

**Interfaces:**
- Consumes: Task 1 SaveGeneratedImage、Task 2 SourceURL；现有 `Downloader.Download(ctx, url)`。
- Produces: 公共接口中 Delivery/Input/DeliveredImage/DeliveryRunner。
- Produces: `images.DownloadError` 实现 error，含 `Status int`、`Retryable bool`、`Err error`，供 delivery 分类；公开客户端错误仍为 apierror，不泄露 Err URL。

- [ ] **Step 1: 写 `TestDeliveryPersistsBeforeReturn`。** fake downloader 返回真实 PNG/JPEG/WebP，fake store 在检查原图内容后返回 StoredImage；阻塞 save 时 Deliver 不得返回；成功返回 ID/publicID/MIME/bytes。`TestDeliveryBase64MatchesOriginal` 解码结果与 store.Image 完全一致；url 请求 Base64=nil。
- [ ] **Step 2: 运行 RED。** `go test ./internal/service -run '^TestDelivery' -count=1`；预期新服务不存在。
- [ ] **Step 3: 实现 Deliver。** 下载同一 SourceURL；校验非空、≤64 MiB、SniffImage 支持且与实际 MIME 一致；写 GalleryInsert 的请求、模型、prompt、账号、source、已知 measurement 和稳定 OutputKey；保存返回成功后才组装 DeliveredImage。下载数据复用，不在 Deliver 做尺寸解析或调用 Edge；IncludeBase64=true 时编码一次，false 时不编码。
- [ ] **Step 4: 实现下载分类与至多两次尝试。** DownloadError 的临时网络错误/429/5xx 可重试，确定性 SSRF/非法 URL/非图片/超限/其他 4xx 不重试；ctx canceled 立即停。总下载窗口 60s，第二次不能重置整个窗口；重试等待 250ms，使用 ctx 可取消 timer，不使用不可取消 sleep。超时映射 504 `image_download_timeout`、其他下载失败 502 `image_download_failed`，保存失败为 503 `image_persist_failed`。source 与原始网络错误不得进入客户端/持久化日志。
- [ ] **Step 5: 写并实现重试/失败测试。** `TestDeliveryRetriesDownloadOnly` 第一次临时失败第二次成功，Download=2、Save=1；`TestDeliveryDeterministicFailureNoRetry` 私网/类型/超限只有一次；`TestDeliveryPersistenceFailureDoesNotRedownload` 保存错误后不重下载/不调 Agnes；`TestDeliveryCanceledRetry` timer 中取消迅速退出。`TestDeliveryAmbiguousWriteRetryIsIdempotent` fake store 首次已保存但返回失败，之后相同 DeliveryInput 重试保持相同 StoredImage/单行（服务不自动再生成）。
- [ ] **Step 6: 验证。** `go test ./internal/images ./internal/service -run 'Test(Remote|Delivery)' -count=1`，SSRF 原测试仍通过；没有本地像素解码/转码依赖。`git diff --check`；不 commit。

### Task 5: 子请求调度、交付聚合与任务生命周期

**Files:**
- Modify: `internal/service/images.go:26-365`
- Test: `internal/service/images_test.go`、`internal/service/recovery_test.go`、`internal/service/tasks_test.go`
- Modify: `internal/store/logs.go:22-123`（使用 Task 1 Partial 统计）
- Modify: `internal/httpapi/images_test.go`、`internal/httpapi/recovery_test.go`（测试 seam 更新，不提前实现公开端点）

**Interfaces:**
- Consumes: DeliveryRunner、MeasureRunner、Tasks、Task 1 日志 DTO。
- Produces: `ImageOptions.Delivery DeliveryRunner` 与 `ImageOptions.Enrichment EnrichmentJobRunner`。
- Produces: `ImageResult.Images []DeliveredImage`、`ImageResult.Created int64`、`ImageResult.Size string`、`Headers`、`Log`、`CommitEnrichment func() error`、`CancelEnrichment func()`；响应 URL 不在 service 中签发。
- EnrichmentJob/Runner 先在 `enrichment_job.go` 定义，Task 6 实现 runner。Task 7 删除旧 ImageResult.Response/CommitArchive/CancelArchive 与 runtime archive wiring；过渡不能重复保存。

- [ ] **Step 1: 写 `TestGenerationWaitsForDelivery`。** 同一子请求 Pool 成功后 delivery 阻塞，Generate 不返回；save 结束才算成功。`TestGenerationDeliveryPartialSuccess`：n=3，中间下载/保存失败，响应只有已存图且顺序正确；成功/失败 headers 合计 n。已有 cancellation/huge n seam 使用真实 fake delivery。
- [ ] **Step 2: 运行 RED。** `go test ./internal/service -run 'TestGeneration(WaitsForDelivery|DeliveryPartialSuccess)' -count=1`；预期新流程断言失败。
- [ ] **Step 3: 将并发许可扩大到生成→交付。** acquire 一次覆盖当前子请求的 Pool.Generate 和全部输出 Deliver，defer release，不能生成后马上释放。在生成前预留一个请求级 Tasks 容量；若任何步骤返回/取消/失败必须恰好释放或将已有保存 IDs 提交后台一次。worker 不把交付失败送回 Pool，不重复 Agnes。URL 请求聚合只留元信息；base64 聚合只留必要字符串，不把字节挂到后台 job。启用Delivery的新路径必须关闭旧CommitArchive保存行为，只安排EnrichmentJob；runtime尚未切换的路径在本任务检查点仍可运行，但不得对已保存输出再次归档。Task6/7最终移除这段过渡接线。
- [ ] **Step 4: 写并实现多输出语义。** `TestGenerationMultiOutputPartial` 单个子请求三张图，保存两张一张失败：Succeeded=1、Failed=0、Images=2、Partial=true、warning 含 partial-success，daily partial=1；DeliveryFailures 含准确 subrequestIndex/imageIndex/stage/status/code。至少一张保存成功算子请求成功，没有保存成功算失败；完全失败继续固定聚合优先级；记录真实 Agnes 成功 attempts，但账号不因 delivery 失败冷却。
- [ ] **Step 5: 保留 Edge URL 测量并聚合。** 对生成的 URL 最多一次按批 Measure，可在收集生成结果后、组装返回前执行；成功保存记录的 measurement 用批结果回填，通过新增 `Store.SetImageMeasurement(ctx, id int64, measurement domain.Measurement) error` 更新 size_actual/source_mime（空测量不覆盖已有值）；将该方法加到本任务的独立 `MeasurementWriter` 接口和 ImageOptions，存储位于 gallery.go。失败只警告 size-measure-failed，不改变交付成功。测量不读取/上传原图；输出 size 继续首个可用测量/预计尺寸，不捏造本地实测。
- [ ] **Step 6: 写生命周期失败测试。** `TestGenerationDeliveryConcurrencyBound` 多个客户端请求同跑，Pool+download+save 活跃总数不超过 MaxInFlight；`TestGenerationCancelAfterSomeSaved` 保存一张后取消，已存图保留、job IDs 精确、Tasks.Pending 最终为0；`TestEnrichmentHandoffExactlyOnce` commit/cancel 并发最多一个成功；全部交付失败不提交富化。完成取消后的清理不能无限读取图片，日志沿用有界 WithoutCancel timeout。
- [ ] **Step 7: 验证检查点。** `go test ./internal/service ./internal/store ./internal/httpapi -count=1`；先用测试 runner 接口验证，不要求本阶段 runtime 公网链接已经接通；`git diff --check`。无 commit。

### Task 6: Edge 按需加载原图与仅 ID 后台富化

**Files:**
- Create: `internal/service/enrichment_job.go`（已有类型补实现）、`internal/service/enrichment_job_test.go`
- Modify: `internal/service/edge.go`、`enrich.go`、`metadata.go`、`backfill.go`
- Modify: `internal/store/gallery.go:294-329`（GalleryEnrichState 只读元信息）
- Delete after rewiring: `internal/service/archive.go`
- Modify: `internal/domain/images.go`、`internal/domain/gallery.go`、`internal/app/runtime.go`（删除archive后的机械接线，公开HTTP签发仍在Task7）
- Test: `internal/service/edge_test.go`、`internal/service/backfill_storage_test.go`、`internal/service/backfill_test.go`、`internal/service/tasks_test.go`

**Interfaces:**
- Consumes: Task 1 GalleryContent/元信息、Task 5 EnrichmentJob/Runner。
- Produces: EnrichmentJobs runner、Edge.WithOriginalReader；GalleryEnrichState 不预读 Data。
- Final: 删除 domain.OutputImage.Base64（URL 字段此阶段保留原 *string 类型，避免不必要类型重构）；删除 GeneratedImage 与 GallerySource.Data/HasImage，使用 `Bytes>0` 和 OriginalReader 判定已存原图。不保留旧 archive runner/interface/options。

- [ ] **Step 1: 写 `TestEnrichmentJobOnlyUsesExistingIDs`。** fake store 禁止插入图片，Run 只能读取给定 IDs 的最新 enrich state；pending/failed 可处理、success/已删除跳过；与 backfill 共享 GalleryLocks。运行期间删除不得复活。`TestEdgeURLPriorityDoesNotReadOriginal` 有源 URL 且成功时 OriginalReader 调用=0。
- [ ] **Step 2: 运行 RED。** `go test ./internal/service -run 'Test(EnrichmentJob|EdgeURLPriority)' -count=1`；预期新 runner/reader 不存在。
- [ ] **Step 3: 实现仅 ID runner 与按需读。** 原图自动同步保存后 job.IDs 中仅数字 IDs，没有 data/base64。逐 ID 加共享锁→重新查 status→Edge.Enrich；后台失败写 failed/enrich_error（源 URL/签名不得进 error），输出同一条 enrich 请求日志；不写 model usage。Backfill 同边界，GalleryEnrichState SQL 不再 SELECT image。Edge.URL fetch 失败时才加载失败 ID 的 GalleryContent(false)，再次确认存在；无 URL 时直接按需加载。
- [ ] **Step 4: 统一实际内联预算。** 保留最多20项、32 MiB decoded source batch budget；明确 decoded 单图50 MiB只是安全上限，超过32 MiB 的 inline 项本期显式 failed `source exceeds batch budget`、不发送，不引入超过契约的大图单独请求。base64 批次在组装前用 EncodedLen 计算并设置实际 JSON 请求上限46 MiB（含字段/参数）；上限在 `postBatch` 内 marshaled 长度二次检查。所有真正 inline 项，无论首轮/重试/与URL混合，都计成本；一批只加载当前发送项，发送后释放字节。URL 元信息测量保持最多20项，不产生 inline 测量重试。
- [ ] **Step 5: 写并实现预算/重试测试。** `TestEdgeInlineBatchBudget`：两个17 MiB原图→两批；混合URL/inline→按实际inline计算；20/21项数量边界；32 MiB inline可发送、32 MiB+1与50 MiB+1明确failed且不发送；actual JSON≤46 MiB。`TestEdgeURLFailureLoadsOriginalOnce` 第一次 URL fetch failed，原图读1次、第二次 base64 成功、真实contentType；第二次失败不再重试；网络整批失败允许 URL 项一次原图重试，缺少 NSFW 等语义错误不重试；加载已删除行不复活。
- [ ] **Step 6: 删除旧归档/双格式内部结构。** 替换 tasks_test 的 archive materialize/metadata fallback 测试为 delivery/enrichment职责测试；移除 unused imports/helpers/Base64/GeneratedImage/Data 引用。runtime 与 HTTP 的旧 archive接线在 Task 7 同步切换；若删除使其无法编译，在本任务最后先进行机械依赖接线（不实现签名响应），确保任务检查点可编译。没有双保存流程或兼容 fallback。
- [ ] **Step 7: 验证。** `go test ./internal/service ./internal/store ./internal/app ./internal/httpapi -count=1`；Edge disabled 与 stored BLOB backfill 行为保持；检查后台 job 内没有原图/encoded字符串。`git diff --check`；不 commit。

### Task 7: 接通签名内容端点、生成响应与 runtime

**Files:**
- Create: `internal/httpapi/image_content.go`、`internal/httpapi/image_content_test.go`
- Modify: `internal/httpapi/router.go:25-109,158-197`、`internal/httpapi/auth.go`、`internal/httpapi/gallery.go`
- Modify: `internal/app/runtime.go:109-181`
- Modify: `internal/preview/preview.go`（mock URL-only、seed OutputKey）
- Test: `internal/httpapi/images_test.go`、`internal/httpapi/recovery_test.go`、`internal/app/runtime_test.go`、`internal/preview/preview_test.go`

**Interfaces:**
- Consumes: Task 3 signer/origin、Task 5 ImageResult、Task 6 runner/Edge reader、Task 1 public read。
- Produces: `PublicImageStore` 包含 PublicImageInfo/PublicImageContent；`httpapi.Options.ImageLinks *auth.ImageLinks`、`PublicImages PublicImageStore`；现有 AdminStore 不因 public读取而获得匿名权限。
- `ImageResponse`/`ImageResponseItem` 从 service 移到 `internal/httpapi/image_response.go`（新）：url/b64_json 均 omitempty，created/data/size保持，revised_prompt保持null，不新增未实现 output_format 字段。

- [ ] **Step 1: 写 `TestSignedImageGETAndHEAD`。** 无Bearer/Cookie，仅有效签名GET=200，正文等于数据库原图；HEAD=200、正确Content-Length、无正文、只调用info；PNG/JPEG/WebP MIME和文件名后缀正确。`TestSignedImageRejectsBeforeStore` 过期/错误/重复query/publicID篡改→统一404，数据库调用=0；有效签名但不存在404，不泄露。所有成功/错误no-store，非法方法405。
- [ ] **Step 2: 运行 RED。** `go test ./internal/httpapi -run '^TestSignedImage' -count=1`；预期路由尚未实现。
- [ ] **Step 3: 实现独立内容路由。** `/v1/images/content/` 精确匹配一个publicID路径段；先signer.Verify，再store；GET/HEAD不套Auth.Data/Admin、不接受Bearer绕过签名；成功MIME/Length/Disposition/nosniff/sandbox。错误404统一OpenAI message/code `image not found`/`not_found`，HEAD错误也不返回正文。DB不可用用503 generic、无内部详情。可复用CORS headers，OPTIONS返回GET/HEAD/OPTIONS允许头；不读取DB，不授予管理权限。
- [ ] **Step 4: 接通同步交付和响应签发。** runtime创建Delivery(Store,Downloader)、EnrichmentJobs(Store,Edge,Locks)、Edge.WithOriginalReader(Store)、ImageLinks(apiKey,Now)，传入各Options；orchestrator不再持有Archiver。HTTP认证/解析后验证origin（在消耗Agnes额度前）；获得ImageResult后使用HTTP边界DTO：url为Issue(origin, Stored.PublicID, 当前请求settingsTTL)，base64为DeliveredImage.Base64，另字段省略。ttl以此时signer.now计算。即使Encode失败/客户端断开，也defer CommitEnrichment一次；service error但已有存图由service完成handoff。
- [ ] **Step 5: 写闭环 HTTP 测试。** `TestHTTPDeliveryURLBase64Equality` 使用真实临时SQLite+mockPool+controlledDownloader，分别生成url/base64，响应前DB原图可查，GET=同一输入原图字节，DTO没有多余format字段。`TestHTTPDeliveryDoesNotReturnAgnesURL` 返回proxy origin；`TestHTTPInvalidPublicOriginDoesNotGenerate` origin错误Pool次数=0；`TestHTTPWriteFailureStillEnrichesSavedIDs` failing ResponseWriter后任务仅一次，原图保留。
- [ ] **Step 6: 写并实现关闭验证。** `TestRuntimeShutdownDuringDelivery` 在save/HTTP写/队列提交不同点触发StopAdmission；已接纳请求可完成提交，HTTP请求关闭后再Drain，不先关闭数据库；超时取消task并报告未完成数。预览mock始终URL，PNG/JPEG/WebP三种生成路径可离线访问，删掉旧mock按return_base64切换行为。
- [ ] **Step 7: 验证。** `npm --prefix frontend run build`（满足go:embed）；`go test ./internal/httpapi ./internal/app ./internal/preview -count=1`；全仓 `go test ./... -count=1` 编译通过且没有CommitArchive等死接口；`git diff --check`。不 commit。

### Task 8: Data URI 校验一致与本程序参考图 URL 闭环

**Files:**
- Create: `internal/httpapi/local_reference.go`、`internal/httpapi/local_reference_test.go`
- Modify: `internal/images/parse.go:147-169,262-374`、`multipart.go:48-85`、`dimensions.go:148-179`
- Modify: `internal/httpapi/router.go:171-172`
- Test: `internal/images/parse_test.go`、`internal/images/remote_test.go`、`internal/httpapi/images_test.go`

**Interfaces:**
- Consumes: Task 3 Verify/当前可信origin、Task 1 PublicImageInfo/Content；原ReferenceReader。
- Produces: 公共接口LocalReferences；`images.ReferenceResolver` 含 `ResolveReference(context.Context, string) (string,error)`，作为可选能力由buildRequest使用，普通Remote仍仅ReferenceReader。
- Produces: `func images.DecodeImageDataURI(value string, maxBytes int) (mime string, data []byte, err error)`；原parseDataURI/decodeDataURI归并到同一严格帮助函数，不维护两套解码规范。

- [ ] **Step 1: 写 `TestReferenceDataURIContentValidation`。** 声明PNG+真实JPEG、`aGk=`、坏padding/字符、空payload、超20MiB均400；真实PNG/JPEG/WebP通过；image/jpg规范为image/jpeg。显式size也必须校验，不靠auto触发。`TestMultipartAndDataURIEquivalentValidation` 同字节/同声明得相同接受结果。
- [ ] **Step 2: 运行 RED。** `go test ./internal/images -run 'Test(ReferenceDataURI|MultipartAndDataURI)' -count=1`；预期旧DataURI宽松逻辑失败。
- [ ] **Step 3: 实现单次校验与规范化预算。** 解码前用encoded长度拒绝明显超限，DecodeImageDataURI调用一次校验真实SniffImage与声明一致，不完整解码像素；使用标准编码生成canonical DataURI。collectImages对已校验结果不要再次DecodeString，auto尺寸可复用一次解码后的请求内数据。累计包括本地URL展开/外部URL/DataURI字符串的规范化参考图列表JSON≤32MiB，超限400 image_too_large；不得用短URL展开绕过。保留max16与每图20MiB。
- [ ] **Step 4: 写 `TestLocalReferenceSignedURLRoundTrip`。** 上次有效proxy URL用于edits：验证签名→metadata大小预检→读取一次正文→转DataURI；mock Agnes收到DataURI而非内网URL。size=auto沿用本地ImageDimensions解析图头，Store正文总读取=1，不自HTTP请求；过期/篡改/删除返回400 image字段，无Agnes请求。显式size也先验签。
- [ ] **Step 5: 实现LocalReferences。** HTTP每次创建实例，合法本地匹配依据配置公开origin或当前可信origin；固定path，scheme/hostname/port规范化后严格一致；不接受fragment/user/未知或重复query。本地错误返回image400通用message，不公开签名详情。非本地reference由原ReferenceReader处理；不是所有同路径URL都本地展开，不放宽Remote SSRF。缓存只在此请求内，先验签后使用缓存；请求内cache不续期。ReferenceResolver在size解析前处理全部图，不仅第0张。
- [ ] **Step 6: 写安全/大小测试。** `TestLocalReferenceForeignOriginNotResolved` 第三方同path/port变化不读本地Store；`TestLocalReferenceAggregateBudget` 两个URL指向各≤20MiB但展开累计>32MiB→400；16张通过/17张拒绝；生产Remote对私网URL仍拒绝。外部HTTPS、DataURI和multipart旧正常用法保持。
- [ ] **Step 7: 验证。** `go test ./internal/images ./internal/httpapi ./internal/preview -count=1`；`git diff --check`；无裸base64猜测或宽松域名匹配。无 commit。

### Task 9: 设置、日志与图库下载的前端完成态

**Files:**
- Modify: `frontend/src/features/settings/settings-page.tsx:13-35,140-231`
- Modify: `frontend/src/features/logs/logs-page.tsx:32-80`
- Modify: `frontend/src/features/gallery/image-dialog.tsx:131-139`
- Test: `frontend/src/features/settings/settings.test.tsx`、`frontend/src/features/logs/logs.test.tsx`、`frontend/src/features/gallery/image-dialog.test.tsx`
- Test: `frontend/e2e/gallery.spec.ts`、`frontend/e2e/console.spec.ts`
- Modify: `docs/api/admin.openapi.yaml`（补齐字段描述，结构已在Task1同步）

**Interfaces:**
- Consumes: Task 1的Settings/RequestLog/Zod契约、服务端正确Content-Disposition。
- Produces: 中文配置表单和交付错误视图；不更改管理Cookie/Bearer、图库BlobCache协议。

- [ ] **Step 1: 写设置失败测试。** `settings.test.tsx` 增加“默认TTL为24小时，保存48小时，重新加载仍为48”；公网地址输入可空/可保存；后端拒绝TTL时保持输入、aria-invalid与错误摘要跳转正确。断言输入min=1,max=720,step=1，精确label为“图片链接有效期（小时）”“图片公网基础地址”。
- [ ] **Step 2: 运行 RED。** `npm --prefix frontend run test -- --run src/features/settings/settings.test.tsx`；预期新label不存在。
- [ ] **Step 3: 实现表单字段。** FIELD_LABELS/NumberKey加入TTL；沿用Input/Field/ErrorSummary；描述TTL仅影响新链接、过期不删除原图；公开地址描述为空自动按可信origin推导。保留Edge字段/图片参数位置，不把TTL改成每日自动删除。
- [ ] **Step 4: 写并实现日志视图测试。** `logs.test.tsx` 的一个attempt200+persist503+Partial=true案例，显示“图片交付失败”区域的子请求、图片序号、阶段和code，不把其添加到上游账号尝试；没有失败时不显示空表。不把源URL/query与签名显示在错误正文。
- [ ] **Step 5: 写并实现下载测试。** `image-dialog.test.tsx` 断言链接不再硬编码`.png`，仍指向管理content?download=1；移除download属性强制错误filename，由HTTP头决定。`gallery.spec.ts` 生成JPEG/WebP后下载suggestedFilename对应.jpg/.webp，文件非空，实际原图可看；url TTL不影响管理员读取。
- [ ] **Step 6: 验证。** `npm --prefix frontend run typecheck`、`npm --prefix frontend run lint`、`npm --prefix frontend run test -- --run`、`npm --prefix frontend run build`；全部PASS，界面不重设计、不增图表、不加新组件依赖；`git diff --check`。无 commit。

### Task 10: 全链路验收、协议文档与完成前检查

**Files:**
- Create: `docs/api/images.openapi.yaml`
- Modify: `README.md:10-14,126-208,222-239`
- Modify: `docs/api/admin.openapi.yaml`
- Test: `internal/preview/preview_test.go`、`internal/httpapi/contract_test.go`、`frontend/e2e/console.spec.ts`、`frontend/e2e/gallery.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–9完成态；不引入新运行期接口。
- Produces: 离线端到端证据、准确API/部署说明、可审查diff；不提交发布。

- [ ] **Step 1: 添加离线HTTP综合测试。** `TestPreviewImageDeliveryContract`：启动真实preview临时SQLite，默认url生成→无需token GET/HEAD，按设置变更TTL，再b64_json与原图字节核对；将有效url用于edits；Edge测量+后台富化可用；删除图后旧签名404；用admin读取过期链接对应图仍成功。测试通过注入时钟，不等待24h；如果preview.Options需要Now，定义`Now func()time.Time`并传入runtime/store/signer，生产nil默认time.Now。
- [ ] **Step 2: 运行针对测试确认预期。** `go test ./internal/preview ./internal/httpapi -run 'Test(PreviewImageDeliveryContract|AdminContractFixture)' -count=1`，预期PASS；不通过先修所属任务，不为测试恢复旧兼容分支。
- [ ] **Step 3: 写图片OpenAPI。** 精确两种response_format、只有所选字段、签名GET/HEAD/OPTIONS、expires秒/publicID/signature限制、404/503、no-store、metadata size best-effort、部分成功头和错误codes；图片内容security仅签名参数，不能继承admin Bearer/Cookie授权。settings/log新字段与共享fixture一致。
- [ ] **Step 4: 更新README。** 删除“URL在响应后下载”“return_base64别名”“仅元数据成功归档”旧描述；写同步持久化、Edge优先源URL/按需base64、1–720h/默认24h、已发链接不受TTL更新影响、密钥轮换/删除、签名URL再次做参考图、公开地址与TRUSTED_PROXY_CIDRS实例、schema2重建要求。明确no-store仍无法撤回已下载副本；大批base64占内存、队列非严格字节上限；Docker无卷/只读根保持。不运行生产reset命令。
- [ ] **Step 5: 全量fresh验证。** 顺序执行：

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run test -- --run
npm --prefix frontend run build
gofmt -l internal cmd
go vet ./...
go test ./... -count=1
npm --prefix frontend run test:e2e
git diff --check
git status --short
```

预期：typecheck/lint/test/build/vet/e2e退出0，gofmt列表为空，Go全部PASS，diff无空白错误。若缺依赖仅在获准实施后执行npm ci；不把生成的webassets/dist、node_modules、.codegraph添加Git。测试失败报告命令与实际输出，不宣称通过。

- [ ] **Step 6: 验证race边界。** 工具链支持时 `go test -race ./... -count=1`；Windows缺CGO/race支持则明确标注未执行原因，不假称通过。关注并发save幂等键、commit/cancel、shared lock、cache与shutdown测试；不借此访问真实服务。
- [ ] **Step 7: 完成前审查。** 调用 verification-before-completion 与 requesting-code-review 对整个最终diff检查（实施时加载技能），重点检查本计划Review Focus五项；修复真实问题并重跑所属测试。检查移除archive与上游Base64分支，不残留旧字段fallback/metadata-only成功路径。最终报告改动、测试证据、旧库需重建、真实Agnes未验证；不commit/push，等待用户后续决定。

---

## 依赖与执行方式

顺序：`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`。Task 3与4逻辑上可独立，但本计划不要求多agent并行；Task 5–8的共享服务接口必须按顺序接通，避免同文件并行编辑。

建议 **Native（本会话逐任务实施，末尾独立整体审查）**：任务多但共享接口紧密，反复交接会增加上下文成本。若用户选择Subagent-driven，则每任务的新实现/审查者读取本计划+设计文档+公共接口表，不重新设计协议。无论采用哪种方式，用户审阅计划并明确要求实施后才开始。

## 自审记录与设计覆盖

- Spec §1目的/约束 → Global Constraints、Task 2/4/6；§2协议/TTL/签名 → Task 1/2/3/7/9/10。
- Spec §3 Agnes/下载/持久化/聚合 → Task 1/2/4/5/7；§4 Edge → Task 5/6；§5参考图 → Task 8。
- Spec §6控制台/文档 → Task 1/9/10；§7验收 → 各task测试+Task10；§8交付边界 → 本计划不授权实施/提交。
- 公共类型和方法按接口表交叉核对；Task5 SetImageMeasurement/MeasurementWriter、Task7响应DTO、Task8ReferenceResolver均在所属任务明确产生，不依赖未定义函数。
- Review Focus五项均已分配测试；Task6明确32MiB批预算与50MiB单图上限的实际失败行为，避免留待猜测。
- 基础阶段保持可编译和DTO一致；旧archive/Base64过渡只用于任务顺序接线，完成态删除，不被作为兼容能力。
- 此计划已完成文档自审，尚未运行新功能测试、编写业务实现或提交任何文件。
