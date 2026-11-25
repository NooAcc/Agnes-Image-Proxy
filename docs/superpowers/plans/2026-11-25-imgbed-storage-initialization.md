# ImgBed Storage and Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加首次初始化和固定的 `local` / `imgbed` 原图存储方式，以数据库保存图床连接信息，按中国时区日期上传并继续提供本程序签名交付。

**Architecture:** 存储配置使用独立单行表，初始化/更新通过独立管理 API；普通设置不包含存储凭据。Store 持有配置生命周期协调并通过统一原图后端接口发布、读取和删除，图床 HTTP 客户端与数据库职责分离。React 在会话守卫之后增加初始化守卫和独立 setup 页面，现有 preview 显式初始化 local。

**Tech Stack:** Go 1.26.1、database/sql、Turso/libSQL、modernc SQLite 测试库、Go 标准库 HTTP/multipart；React 19、TypeScript、React Router、TanStack Query、Zod、现有 Tailwind/shadcn 组件、Vitest/Testing Library、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-25-imgbed-storage-initialization-design.md`。执行者必须先读 spec 和本计划。

## Global Constraints

- schema **4**；替换 `image_path` 为 `original_ref`。不迁移旧 schema，不保留旧 DTO/字段 fallback，不双写原图。
- 首次必须明确选择 `local` / `imgbed`；之后方式固定，图床仅可更新站点地址及 Token。
- 存储配置存数据库，不添加原图存储环境变量；现有 `PROXY_API_KEY`、Turso、`DATA_DIR` 等启动配置不变。
- 固定上传 `serverCompress=false`、`returnFormat=full`、`uploadFolder=agnes-image-proxy/YYYY-MM-DD`，不增加其他 query 参数。
- 日期取上传开始时 **UTC+8（中国标准时间）**，使用固定 +28800 秒偏移，不依赖系统本地时区或 tzdata；签名/数据库绝对时间不变。
- 原图仅 PNG/JPEG/WebP，非空，最大 **64 MiB**；上传响应最大 **1 MiB**，默认且恰好一项的数组响应。
- imgbed 上传成功后回读并核对原图字节完全一致，再发布图库；不自动重试上传、不缓存永久本地原图。
- 图床地址是公开可路由 **HTTPS origin**；上传/删除不跟随重定向，公开读取最多两次 HTTPS 重定向，各跳及拨号均防 SSRF，禁用环境 HTTP proxy。
- Token trim 后必填、最多 **4096 字节**、无控制字符，要求 `upload` / `delete`；数据库保管明文，但管理响应/日志/URL/浏览器持久化存储不得泄露。
- 保留签名 URL、b64_json、参考图复用、富化回退与缩略图的现有功能；imgbed 读取不带 Token，不 302 到图床、不回源 Agnes。
- 数据库阶段默认 **15 秒**；一次原图操作 **60 秒**，父 context 取消优先；不能将数据库 operation context 套住整个上传生命周期。
- 单实例；不扩展后台 GC、文件浏览、分块上传、多实例协调、迁移或兼容层。不新增依赖。
- 本计划只描述实现；编写计划不提交 Git、不启动真实图床请求、不执行 reset。实施时只有用户授权提交才执行各任务的提交步骤；如在 main 上实施且需要提交，先创建普通功能分支，不自行建立 worktree。

## Review Focus

下列隐含输入/失败模式在相应任务中增加专门回归测试：

1. 中国时间午夜而服务器仍是前一日：目录在 UTC 16:00 切日，跨午夜回读/清理仍引用原目录（Task 3）。
2. 上传回读期间换站点/Token或取消更新：旧操作不得混用配置，更新可取消，随后新操作必须使用新值（Task 4）。
3. 远端 HTTP 200 但删除失败、或清空中途失败：失败条目定位和 Token 必须留下，重试不能误删未登记图床文件（Task 5）。
4. 图床 HEAD 没长度或重定向到保留地址：不得偷偷 GET、泄露 Token或绕过网络边界（Task 2/3）。
5. 两个管理标签页初始化竞态或状态请求出错：冲突者重新获取状态，不能重开选择、闪入控制台或展示 Token（Task 6/7）。

---

## File Structure and Interfaces

### 新文件与职责

| 文件 | 单一职责 |
| --- | --- |
| `internal/domain/storage.go` | 固定方式、配置/请求/脱敏状态类型和格式验证 |
| `internal/store/storage_config.go` | 单行配置读取、唯一初始化和连接信息更新 |
| `internal/store/storage_gate.go` | 可取消、有写者优先的配置生命周期读写协调 |
| `internal/safehttp/client.go` | 从 images.Remote 提取共享的 URL/DNS/拨号/重定向边界 |
| `internal/imgbed/client.go` | 固定参数上传、回读、HEAD、单文件删除 |
| `internal/imgbed/paths.go` | UTC+8 日期、src 校验、相对 file ID 和逐段 URL 编码 |
| `internal/store/originals.go` | 原图接口、local/imgbed adapter、配置快照、校验/错误转换 |
| `internal/store/gallery_delete.go` | 将图库删除/清空从 gallery.go 拆出；远端优先、部分失败保留定位 |
| `internal/httpapi/storage.go` | storage GET/POST/PUT 与初始化门禁 |
| `frontend/src/features/storage/use-storage.ts` | 脱敏状态查询、初始化/更新请求 |
| `frontend/src/features/storage/guards.tsx` | 已初始化/未初始化路由守卫 |
| `frontend/src/features/storage/setup-page.tsx` | 首次选择及条件表单 |
| `frontend/src/features/storage/storage-settings.tsx` | 只读方式、可更新图床地址/Token |
| `frontend/src/features/storage/upload-rules.tsx` | 两个页面共用只读参数和中国时区说明 |

每个新 Go 文件配同目录 `*_test.go`（adapter 测试为 `originals_test.go`）；前端测试为 `setup.test.tsx`、`storage-settings.test.tsx`、`guards.test.tsx`。具体集成测试和修改文件在任务中列出。

### 主要共享契约（各任务 Interfaces block 是实现来源）

- `domain.StorageMode`：字符串，常量 `StorageLocal="local"`、`StorageImgbed="imgbed"`。
- `domain.StorageConfig`：`Mode StorageMode; ImgbedBaseURL string; ImgbedToken string`，全部 `json:"-"`，内部使用。
- `domain.StorageStatus`：`Initialized bool`、`Mode StorageMode`、`ImgbedBaseURL string`、`HasImgbedToken bool`；除 Initialized 外使用 `omitempty`，序列化结果严格匹配 spec 的三种对象。
- `domain.StorageInit`：`Mode StorageMode; ImgbedBaseURL *string; ImgbedToken *string`，指针用于区分字段缺失/显式空值，JSON 字段名按 spec。
- `domain.StorageUpdate`：`ImgbedBaseURL string; ImgbedToken *string`，不含 mode；省略/空 Token 保留，显式 null 拒绝（HTTP 严格解码检查）。
- `imgbed.Object`：`Ref string; MIME string; Bytes int64`。Ref 是已解码安全 file ID，无站点地址。
- `originalBackend`（store 内部）：`Write(ctx context.Context, publicID, mime string, data []byte) (ref string, verified []byte, err error)`；`Read(ctx context.Context, ref, mime string, size int64) ([]byte,error)`；`Verify(ctx context.Context, ref, mime string, size int64) error`；`Delete(ctx context.Context, ref string) error`。
- `storageGate`（store 内部）：`acquire(ctx context.Context, exclusive bool) (release func(), err error)`，零值可用。
- 锁顺序固定：**storageGate → galleryGate → outputLocks（仅保存）→ imageLocks**；公有方法不得嵌套调用另一个会取这些锁的公有方法。

---

### Task 1: 存储配置、schema 4 与唯一初始化

**Files:**
- Create: `internal/domain/storage.go`, `internal/domain/storage_test.go`, `internal/store/storage_config.go`, `internal/store/storage_gate.go`, `internal/store/storage_config_test.go`, `internal/store/storage_gate_test.go`
- Modify: `internal/store/schema.go:15-52,54-148,181-246`, `internal/store/database.go:29-49`, `internal/store/gallery.go:137-146`, `internal/store/image_content.go:14`（后两处仅改新列名）
- Test/fixtures: `internal/store/schema_test.go`, `internal/store/accounts_test.go`, `internal/store/image_content_test.go`, `internal/store/local_gallery_test.go`, `internal/store/local_fault_test.go`, `internal/store/local_thumbnail_test.go`, `internal/store/logs_gallery_test.go`, `internal/store/recovery_test.go`

**Interfaces:**
- Produces domain types above, `ValidateStorageInit(in StorageInit) (StorageConfig,error)`, `NormalizeImgbedBaseURL(raw string) (string,error)`, `ValidateImgbedToken(raw string) (string,error)`, `StorageConfig.Status() StorageStatus`.
- Produces Store methods `ReadStorageConfig(ctx context.Context) (domain.StorageConfig,bool,error)`, `StorageStatus(ctx context.Context) (domain.StorageStatus,error)`, `InitializeStorage(ctx context.Context,in domain.StorageInit) (domain.StorageStatus,error)`, `UpdateImgbedStorage(ctx context.Context,in domain.StorageUpdate) (domain.StorageStatus,error)`.
- Produces internal `readStorageConfig(ctx context.Context) (domain.StorageConfig,bool,error)` DB-only helper（不取gate）供已持有storageGate的调用者使用。ReadStorageConfig/StorageStatus取read gate，init/update取write gate；所有DB阶段独立 `s.operation(ctx)`。

- [ ] **Step 1: 写配置/schema/gate 的失败测试。** 使用现有 `newSchemaStore(t)` 和标准库 assertions；新增 `TestStorageSchemaUninitialized`、`TestStorageInitValidation`、`TestStorageInitConcurrent`、`TestStorageUpdateFixedModeAndRetainedToken`、`TestStorageCorruptRowNotUninitialized`、`TestStorageGateCancellationAndWriterPriority`。以下断言是最小核心：

```go
status, err := s.StorageStatus(context.Background())
if err != nil || status.Initialized { t.Fatalf("fresh status = %+v, %v", status, err) }
status, err = s.InitializeStorage(context.Background(), domain.StorageInit{Mode: domain.StorageLocal})
if err != nil || status.Mode != domain.StorageLocal { t.Fatalf("init = %+v, %v", status, err) }
raw, _ := json.Marshal(status)
if string(raw) != `{"initialized":true,"mode":"local"}` { t.Fatalf("status = %s", raw) }
```

测试同时钉住：schema 标识 4、`storage_config` 零行、`original_ref` 存在且 `image_path` 不存在；一条 INSERT 竞态仅一方成功；Token 4096/4097、CR/LF/null、local 显式附带空图床字段拒绝；HTTPS origin 默认端口规范化；raw SQL mode 更新被拒绝。

- [ ] **Step 2: 跑红测试。** `go test ./internal/domain ./internal/store -run 'Storage|Schema' -count=1`；预期 FAIL：新方法不存在或 schema 仍为 3。
- [ ] **Step 3: 实现类型、验证和 schema。** 独立配置表使用 `CHECK(id=1)`、方式/字段组合 CHECK；增加 `BEFORE UPDATE OF mode` trigger（新旧不同则 ABORT），纳入 schema 校验和 reset 自有表。`original_ref` 替代旧列，更新现有 SQL/fixtures 中字段拼写，不增加兼容字段。初始化不播种配置；非法持久化行返回 `503 invalid_storage_config`，缺行才是未初始化。
- [ ] **Step 4: 实现 gate 与配置存储。** gate 用 mutex 保护 readers/waitingWriters/writer 状态和关闭后重建的通知 channel；等待 select context，写者等待时阻止新读者；不为每次等待启动 goroutine。更新和初始化在写 gate 内作 DB CAS/唯一写入；返回 409 codes 按 spec。local 初始化重新做一次目录可写 probe 并删除 probe；imgbed 不联系远端。初始化先检查已有记录，因此已初始化 POST 不会因新 payload 改变配置。
- [ ] **Step 5: 跑绿测试。** 同 Step 2；配置 JSON 测试确认 Token 不可被普通序列化泄露。此任务只更新 schema SQL 拼写，不让旧测试隐式获得 local；需原图的 tests 在 Task 4 显式初始化。
- [ ] **Step 6: 仅获提交授权时提交该任务。** `git add internal/domain/storage*.go internal/store/storage*.go internal/store/schema.go internal/store/database.go internal/store/*test.go internal/store/gallery.go internal/store/image_content.go`；`git commit -m "feat!: add immutable storage configuration and schema 4"`。

### Task 2: 共用受控 HTTP 边界，不放宽参考图安全

**Files:**
- Create: `internal/safehttp/client.go`, `internal/safehttp/client_test.go`
- Modify: `internal/images/remote.go:26-75,183-288`, `internal/images/remote_test.go`

**Interfaces:**
- Produces `safehttp.Resolver` / `Dialer`（方法同现有 images 接口），`Options{Resolver Resolver; Dialer Dialer; Transport http.RoundTripper}`，`Policy{AllowHTTP bool; MaxRedirects int}`。
- Produces `New(options Options) *Client`、`(*Client).Do(req *http.Request,policy Policy) (*http.Response,error)`。
- Consumes no storage config；imgbed 使用 Policy{AllowHTTP:false,MaxRedirects:0/2}。images 的 RemoteOptions 保持自身用途，字段改用 safehttp 类型，不保留重复 DNS/拨号实现。

- [ ] **Step 1: 写失败测试。** `TestSafeHTTPRejectsReservedDNSAndRebinding`、`TestSafeHTTPRedirectPolicies`、`TestSafeHTTPIgnoresEnvironmentProxy`。fake resolver 首次返回公网、拨号时返回私网，断言 dialer 未拨私网；含 Authorization 且 MaxRedirects=0 时，断言重定向目标收到 0 次请求。

```go
// 每个子测试提供记录调用次数的注入 Resolver/Dialer/Transport，不访问真实网络。
for _, ip := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1"} {
    // 断言该地址既不能用作初始站点，也不能作为公开读取的重定向/重绑定目标。
}
```

MaxRedirects=2 精确测试第三跳被拒绝；HTTP 仅 Policy.AllowHTTP 明确开启时可用。
- [ ] **Step 2: 跑红测试。** `go test ./internal/safehttp ./internal/images -count=1`；预期新包不存在。
- [ ] **Step 3: 将已有网络算法移入 safehttp。** Do 在预检、CheckRedirect、实际 DialContext 三处验证；policy 通过 request context 传给 transport/redirect，Transport.Proxy=nil，TLS 最低 1.2；MaxRedirects=0 用 `http.ErrUseLastResponse`，由调用者拒绝 3xx。注入 Transport 仍执行 URL/DNS 预检，测试注入公网 DNS。images.Remote 保留图片 body/MIME/预算逻辑，Dimensions 用原参考图允许 HTTP 的策略，Download 严格 HTTPS。把针对移动的私有网络函数测试移动到新包，不写转发兼容函数。
- [ ] **Step 4: 跑绿测试。** `go test ./internal/safehttp ./internal/images -count=1`；现有参考图/下载取消、超限、重定向测试全部 PASS。
- [ ] **Step 5: 仅获提交授权时提交。** `git add internal/safehttp internal/images/remote.go internal/images/remote_test.go`；`git commit -m "refactor: share controlled outbound HTTP boundaries"`。

### Task 3: 图床客户端与中国时区路径契约

**Files:**
- Create: `internal/imgbed/client.go`, `internal/imgbed/paths.go`, `internal/imgbed/client_test.go`, `internal/imgbed/paths_test.go`

**Interfaces:**
- Consumes domain URL/Token 验证、safehttp Client/Policy。
- Produces `imgbed.Options{HTTP safehttp.Options; Now func() time.Time}`、`New(cfg domain.StorageConfig,opts Options) (*Client,error)`。
- Produces `(*Client).Upload(ctx context.Context,publicID,mime string,data []byte) (Object,[]byte,error)`、`Read(ctx context.Context,object Object) ([]byte,error)`、`Head(ctx context.Context,object Object) error`、`Delete(ctx context.Context,ref string) error`。
- Produces `ValidRef(ref string) bool`、内部 `uploadFolder(at time.Time) string`、`parseUploadSource(src,baseURL,folder string) (string,error)`、`fileURL(baseURL,endpoint,ref string) (string,error)`。
- Produces `ErrNotFound` sentinel；所有其他远端错误的 Error() 仅包含操作/状态码，不回显 src/Token/body。

- [ ] **Step 1: 写请求/时间边界失败测试。** 注入 roundtripper 解析 multipart 并检查仅 file 一项、精确字节和 Content-Type、Authorization、三个 query 且无额外参数；返回配置 origin 的单项 src，第二次模拟 GET 返回同原图。日期断言：

```go
before := time.Date(2026, 11, 25, 15, 59, 59, 0, time.UTC)
after := before.Add(time.Second)
if got := uploadFolder(before); got != "agnes-image-proxy/2026-11-25" { t.Fatal(got) }
if got := uploadFolder(after); got != "agnes-image-proxy/2026-11-26" { t.Fatal(got) }
```

增加 `TestUploadCrossMidnightKeepsRef`：上传取 before、响应/回读在 after，GET/候选删除仍是 25 日路径。
- [ ] **Step 2: 写响应/读取/删除失败测试。** 命名 `TestUploadResponseIdentity`（对象/空数组/两项/relative src/异站/错日期/1MiB+1/尾随 JSON/短链接/expiresAt 拒绝）、`TestRefRoundTripEncoding`（中文、空格和字面 `%` 正确往返；`%2f`、`%5c`、`..`、控制字符拒绝）、`TestUploadRequiresIdenticalReadback`（MIME/字节不同不成功）、`TestHeadNeverDownloadsBody`（body Read 一旦调用就失败，长度缺失仍成功，长度不符失败）、`TestDeleteLogicalFailureAndMissing`（200 false 失败，200 true/existed false 成功）。保留 404 与 403 不同分类；GET 最大 64MiB；取消和超时停止请求，不盲目 retry。
- [ ] **Step 3: 跑红测试。** `go test ./internal/imgbed -count=1`；预期缺新实现。
- [ ] **Step 4: 实现 paths.go。** 时区 `time.FixedZone("China Standard Time",8*60*60)`；仅解码一次每个 EscapedPath 段，拒绝解码后 `/`、`\\`、空/点段/控制字符；ValidRef 只接受 `agnes-image-proxy/<合法 YYYY-MM-DD>/<单个安全文件名>`。上传校验额外精确匹配本次 folder。构造访问/删除 URL 对每个解码段 PathEscape，不用 path.Clean 吞掉非法输入。不从 publicUrl 回退。
- [ ] **Step 5: 实现 client.go。** 上传/回读总预算 60s，Read 60s，Head 10s，Delete 30s；都继承更短父截止时间。用 multipart header/footer + `io.MultiReader` 拼已在内存的原图，设置可计算 Content-Length，避免再复制 64MiB buffer或泄漏 pipe goroutine。Upload 读回完整图片、SniffImage/MIME/长度/bytes.Equal 均匹配后返回 Object 和已验证数据；可解析安全 ref 的到期/回读失败候选尽力删除，清理使用同配置快照和最多5s独立预算，显式 `context.WithoutCancel(ctx)` 仅用于确定未发布候选的清理，不用于上传/交付或DB发布。清理失败保留原上传错误，不能为此声称交付成功或无限等待。HEAD 无 Content-Length 用已保存长度；POST/删除拒绝3xx；所有公开读取无 Token。
- [ ] **Step 6: 跑绿测试。** `go test ./internal/imgbed ./internal/safehttp -count=1`；须同时检查没有真实公网请求及 HEAD body 读取。
- [ ] **Step 7: 仅获提交授权时提交。** `git add internal/imgbed`；`git commit -m "feat: add verified ImgBed originals with China time folders"`。

### Task 4: Store 统一原图发布/读取与配置快照

**Files:**
- Create: `internal/store/originals.go`, `internal/store/originals_test.go`, `internal/store/imgbed_gallery_test.go`
- Modify: `internal/store/database.go:20-49,94-104`, `internal/store/gallery.go:27-163,265-277`, `internal/store/image_content.go:14-100`, `internal/store/gallery_files.go:5-7`
- Test/fixtures: `internal/store/local_gallery_test.go`, `internal/store/image_content_test.go`, `internal/store/local_fault_test.go`, `internal/store/local_thumbnail_test.go`, `internal/store/logs_gallery_test.go`, `internal/store/recovery_test.go`, `internal/service/delivery_test.go`, `internal/service/delivery_boundaries_test.go`, `internal/service/enrichment_job_test.go`, `internal/service/backfill_storage_test.go`

**Interfaces:**
- Consumes `originalBackend`、storage gate/config 和 imgbed client。
- Produces `store.NewOptions{Now func() time.Time; DataDir string; Imgbed imgbed.Options}`；**替换**构造签名为 `New(db *sql.DB,opts NewOptions) (*Store,error)`，不保留旧/variadic兼容构造。`store.Options` 给生产 Open 增加 `Imgbed imgbed.Options`（测试注入，不是环境配置）。
- Produces internal `beginOriginal(ctx context.Context) (originalBackend,func(),error)`：取 storageGate read，读配置快照，构造 adapter，返回释放函数；缺配置 `503 initialization_required`。
- Keeps public `SaveDeliveryImage(ctx,insert,includeOriginal) (domain.StoredImage,[]byte,error)`、`SaveGeneratedImage`、`InsertGallery`、`ImageInfo`、`PublicImageInfo`、`PublicImageContent`、`GalleryContent` 签名不变。

- [ ] **Step 1: 写失败集成测试。** `TestImgbedGalleryPublishReadAndNoLocalOriginal`：初始化 imgbed、注入安全 fake HTTP、保存真实 PNG，assert 原图 ref 为日期 file ID、无本地 original、GET/HEAD正确；`TestStorageUpdateWaitsForUploadSnapshot`：通道阻塞 upload回读，发更新，确认更新未完成、回读用旧 origin且无Token、候选清理用旧 Token，释放后新保存用新值；`TestStorageUpdateCancellationDoesNotApply`：等待更新 context 取消返回 context error且原配置不变。
- [ ] **Step 2: 写幂等/超时失败测试。** `TestImgbedDuplicateReturnsAuthoritativeOriginal`：同 outputKey 两份不同有效 PNG，只保留首次对象并返回首次 bytes；`TestImgbedUncertainPublicationRetainsCandidate`：借现有 recovery driver 模拟“已提交但返回错误”，assert候选未删；`TestOriginalNetworkNotBoundByDBTimeout`：注入短 DB timeout，网络耗时超 DB timeout但低于 operation预算仍成功，避免实际等待15秒。local 不发 HTTP、未初始化保存不写文件；HEAD只走 Verify。
- [ ] **Step 3: 跑红测试。** `go test ./internal/store -run 'Imgbed|Original|StorageUpdate|LocalGallery' -count=1`。
- [ ] **Step 4: 实现 adapter/构造与锁序。** local adapter 重用 pinned localFiles 原子写/读/stat/remove，对 ref精确校验publicID/MIME身份；imgbed adapter重用客户端。Write两种实现均返回已验证数据；local 写后读回验证，imgbed已有回读不得再下载。公有原图操作外层60s、取 storage read后 gallery锁，不嵌套15s DB ctx；imageMetadata、generation读取/发布SQL等每个DB步骤单独 operation并立即关闭Rows。
- [ ] **Step 5: 改发布和读取算法。** 正常保存先按outputKey查询已有对象并读/验证已有内容；不存在才生成publicID并Write，然后执行generation-fenced INSERT。确定冲突清理候选并读权威行；不确定提交保留候选。metadata-only InsertGallery 仍可用于显式初始化后的内部种子，ref为空时不调用后端；未初始化不能播种。读取从original_ref和snapshot adapter校验；移除local-only original路径校验，保留缩略图身份/备份逻辑。原图验证失败映射503，远端404映射galleryNotFound，context取消不吞。
- [ ] **Step 6: 更新构造及测试初始化。** 用 CodeGraph 搜索 `store.New` 全部调用并改 NewOptions；现有有图库数据的 fixtures 显式 InitializeStorage(local)。`newSchemaStore` 保持未初始化；需要原图的store测试新增 `newInitializedSchemaStore`，不能让schema空库断言失真。外部 service/httpapi/app fixtures同理逐个选择local，不增加生产自动默认逻辑。
- [ ] **Step 7: 跑绿测试。** `go test ./internal/store ./internal/service -count=1`；重复、权限、缩略图恢复及富化回退的现有回归全部PASS。
- [ ] **Step 8: 仅获提交授权时提交。** `git add internal/store internal/service/*test.go` 加本任务实际改动的其他构造调用文件；`git commit -m "feat!: route original lifecycle through fixed storage backends"`。

### Task 5: 删除/清空/reset 可重试，不丢失远端定位

**Files:**
- Create: `internal/store/gallery_delete.go`, `internal/store/gallery_delete_test.go`, `internal/store/imgbed_reset_test.go`
- Modify: `internal/store/gallery.go:529-586`, `internal/store/schema.go:274-301`, `cmd/agnes-proxy/commands.go:176-205`, `cmd/agnes-proxy/commands_test.go`
- Test: `internal/store/recovery_test.go`, `internal/store/local_fault_test.go`, `internal/store/schema_test.go`

**Interfaces:**
- Consumes beginOriginal / adapter Delete 与 Task 4锁序。
- Keeps `DeleteGallery(ctx,id) (bool,error)`、`ClearGallery(ctx) error`、`ResetSchema(ctx,confirmed bool) error`。
- Produces `deleteGalleryLocked(ctx context.Context,backend originalBackend,id int64) (bool,error)` 和 `clearGalleryLocked(ctx context.Context,backend originalBackend) error` 内部 helpers；均不再获取storage/gallery gate，调用者负责。SQL query/tx只在DB阶段持有。

- [ ] **Step 1: 写失败测试。** `TestImgbedDeleteFailurePreservesRef`、`TestImgbedClearStopsAndCanRetry`、`TestImgbedResetFailurePreservesCredentials`、`TestResetSchema4ReturnsUninitialized`。精确场景：三个条目按id升序删除；第2个HTTP200 `{success:false}`，assert第1消失、2/3保留、Token不变；重试existed=false仍成功；请求只能含登记的单文件路径，无 `folder=true`、batch/list、整目录删除。
- [ ] **Step 2: 写DB不确定及确认失败测试。** 模拟远端删除成功而DB删除失败，assert行仍在、第二次幂等删除后可清除；reset未confirm环境getter/DB open/HTTP请求次数均0；旧schema经明确reset可重建4且不尝试解读其原图，schema4损坏配置不得当旧库跳过清理凭据。
- [ ] **Step 3: 跑红测试。** `go test ./internal/store -run 'Delete|Clear|Reset' -count=1`，`go test ./cmd/agnes-proxy -run Reset -count=1`。
- [ ] **Step 4: 拆出并实现删除流程。** 单删storage read→gallery read→image锁，读记录→adapter.Delete→受publicID保护DB删除→缩略图目录删除；失败保留必要定位。清空storage read→gallery write，先独立DB事务推进generation再逐页按id升序（每页100）清理；每对象60s预算、整体受调用者context，不套全局15/60s导致大图库必然失败；失败停止，成功后清local candidate namespace。metadata-only行跳过原图删除。
- [ ] **Step 5: 实现reset分支。** confirm检查仍最先；storage write→gallery write。识别当前schema4时读配置并调用不加锁的clear helper，失败不drop；未初始化且无图库允许直接重建，未初始化却有原图记录报错。缺app_meta/旧版本仅执行原有显式自有表重建和local清理；schema4损坏不能回退旧处理。重建零storage row；CLI warning/help/output改为包含“已登记图床原图”，禁止报完全清理远端孤立文件。
- [ ] **Step 6: 跑绿测试。** 同Step3，并运行 `go test ./internal/store -count=1`；确认local无关文件、安全namespace和generation fence回归不变。
- [ ] **Step 7: 仅获提交授权时提交。** `git add internal/store/gallery_delete*.go internal/store/imgbed_reset_test.go internal/store/gallery.go internal/store/schema.go internal/store/*test.go cmd/agnes-proxy/commands*.go`；`git commit -m "feat!: make gallery and reset cleanup storage-aware"`。

### Task 6: 管理 storage API、初始化门禁与 runtime/preview

**Files:**
- Create: `internal/httpapi/storage.go`, `internal/httpapi/storage_test.go`, `internal/httpapi/initialization_test.go`
- Modify: `internal/httpapi/router.go:26-39,163-175`, `internal/httpapi/admin.go:16-63`, `internal/httpapi/assets.go:17-26`, `internal/app/runtime.go:68-179`, `internal/preview/preview.go:96-134`
- Test/fixtures: `internal/httpapi/admin_test.go`, `internal/httpapi/contract_test.go`, `internal/httpapi/testdata/admin-contracts.json`, `internal/httpapi/assets_test.go`, `internal/httpapi/image_content_test.go`, `internal/httpapi/image_lifecycle_test.go`, `internal/app/runtime_test.go`, `internal/app/delivery_shutdown_test.go`, `internal/preview/preview_test.go`

**Interfaces:**
- Produces `httpapi.StorageStore` interface：StorageStatus/InitializeStorage/UpdateImgbedStorage 三个Store方法签名按Task1。
- `httpapi.Options` 增加 `Storage StorageStore`，runtime注入Store；管理storage不扩充秘密字段到AdminStore/Settings。
- Produces `(*router).handleStorage(w http.ResponseWriter,req *http.Request)`、`(*router).requireInitialized(ctx context.Context) error`；缺Storage依赖返回503，不以nil默认已初始化。
- 前端消费 `/admin/api/storage` 的GET/POST/PUT，只收脱敏Status。

- [ ] **Step 1: 写失败HTTP测试。** `TestStorageHTTPStatesAndSecrets`（GET三状态精确keys，POST201/重复409，PUT保留Token/替换、不接受mode/null/未知字段）、`TestStorageAuthAndOrigin`（无凭据401，Cookie跨域mutation403，Bearer合法）；使用独立未初始化env，不能复用默认local env掩盖测试。
- [ ] **Step 2: 写门禁/竞态失败测试。** `TestInitializationGatesBeforeAnyRemoteWork` 对generations、JSON/multipart edits和所有普通admin路径assert已鉴权503/code initialization_required、upstream/downloader/reference/task counters均0；OPTIONS保持CORS，未鉴权POST401优先。会话、storage、静态、health/deep、models可用。数据库读错返回database错误而非uninitialized。并发POST一201一409，GET只剩唯一方式。
- [ ] **Step 3: 跑红测试。** `go test ./internal/httpapi ./internal/app ./internal/preview -run 'Storage|Initialization|Assets|Preview' -count=1`。
- [ ] **Step 4: 实现API与runtime接线。** 先验证管理权限，再在handleAdmin将精确storage路径路由，其他路径requireInitialized；data handler在ReadSettings/参考图解析前门禁。严格请求JSON使用presence检查拒绝null、local任意图床字段（包括空/null），POST已初始化始终409。状态序列化匹配spec，no-store；assets白名单加 `/admin/setup`，不开放所有SPA路径。runtime新/旧状态均能启动，不预设后端或联系图床；shutdown资源关闭顺序不变。
- [ ] **Step 5: 更新preview和fixtures。** preview runtime建schema后、seed前显式InitializeStorage(local)；所有原正常http/app fixtures显式local、Options.Storage注入；生成器/存储接口mock跟新签名。contract fixture新增 storageUninitialized/storageLocal/storageImgbed三个脱敏样本，contract测试使用真实状态样本验证keys，不用零值对象检查omitempty分支。
- [ ] **Step 6: 跑绿测试。** `go test ./internal/httpapi ./internal/app ./internal/preview ./cmd/agnes-proxy -count=1`；preview GETstorage=local且仍离线，setup直接刷新可取index，签名/鉴权回归通过。
- [ ] **Step 7: 仅获提交授权时提交。** `git add internal/httpapi internal/app internal/preview cmd/agnes-proxy`；`git commit -m "feat: expose authenticated initialization and storage management"`。

### Task 7: React 初始化守卫、表单与固定存储设置

**Files:**
- Create: `frontend/src/features/storage/use-storage.ts`, `guards.tsx`, `setup-page.tsx`, `storage-settings.tsx`, `upload-rules.tsx`, `setup.test.tsx`, `storage-settings.test.tsx`, `guards.test.tsx`
- Modify: `frontend/src/app/router.tsx:11-29`, `frontend/src/features/auth/login-page.tsx:13-33`, `frontend/src/features/settings/settings-page.tsx:318-330`, `frontend/src/lib/schemas.ts`, `frontend/src/lib/contracts.ts`, `frontend/src/lib/query-keys.ts`, `frontend/src/test/handlers.ts`, `frontend/src/lib/schemas.test.ts`, `frontend/src/features/auth/auth.test.tsx`

**Interfaces:**
- Produces `storageStatusSchema`（strict union三个spec对象）、`storageInitSchema`（strict mode联合）、`storageUpdateSchema`（strict地址/可选Token）；types `StorageStatus`、`StorageInit`、`StorageUpdate`。
- Produces `useStorage()`、`useInitializeStorage()`、`useUpdateImgbedStorage()`；key `queryKeys.storage=["storage"]`。
- Produces `RequireInitialized`、`RequireUninitialized`（无props，Outlet边界），`SetupPage`、`StorageSettings`、`UploadRules` React组件。
- 路由session→setup uninitialized分支 / initialized→AppShell；login成功仍可先navigate目标，storage guard在渲染AppShell前改去setup，避免循环。

- [ ] **Step 1: 写setup/guard失败测试。** 使用现有renderApp/mockserver，AdminState新增storage，旧tests默认明确local，新setup tests指定未初始化；assert两项初始均unchecked、button禁用、local无Token框、imgbed需要地址Token、提交仅spec字段、错误保留值、成功清除草稿且到overview：

```tsx
const state = createAdminState({ storage: { initialized: false } });
server = startServer(adminHandlers(state));
const { router } = renderApp(["/gallery"]);
expect(await screen.findByRole("heading", { name: "初始化 Agnes Image Proxy" })).toBeVisible();
expect(router.state.location.pathname).toBe("/setup");
expect(screen.getByRole("button", { name: "完成初始化" })).toBeDisabled();
expect(screen.getByRole("radio", { name: /本地存储/ })).not.toBeChecked();
```

`Test`/`it`名：`redirects before mounting shell`、`retries failed storage status without setup fallback`、`refetches status after initialization conflict`。最后一项后端模拟409后GET已初始化，assert跳overview而非重开选择；失败不吞服务错误。
- [ ] **Step 2: 写storage settings失败测试。** `keeps mode read only`、`omits empty replacement token`、`updates base and token without caching secret`、`preserves draft on rejected update`。断言只读方式无radio/select、Token密码框初始为空、按钮pending、saved live region；检查QueryClient只含脱敏GET/成功response，localStorage未写Token。TanStack mutation记录可能保留请求variables，因此成功/失败 settled后 `reset()` mutation、禁止persist mutation，失败草稿仅留当前表单组件内存。
- [ ] **Step 3: 跑红测试。** `npm --prefix frontend test -- --run src/features/storage src/lib/schemas.test.ts`；预期路由/组件/schema缺失。
- [ ] **Step 4: 实现schemas/hooks/守卫。** 类型联合不接受错误mode关联字段，contracts导出类型；query仅有效会话路由后启用，初始化状态使用短staleTime，挂载重新获取以处理另一标签页；状态加载/错误独立展示，不先挂载AppShell。提交成功set脱敏query data、清Token草稿；409初始化冲突只invalidate/refetch，不当成功吞异常。login destination为setup而已初始化时guard转overview。
- [ ] **Step 5: 实现setup和settings。** 复用现有Field/Input/Button/ErrorState和语义tokens；原生fieldset/radio，每个目标44px；不预选；中文必填错误关联输入；只读说明中国时区、不压缩、完整地址。settings storage区放普通SettingsForm外，单独提交，不污染Settings整体PUT；Token留空保留、更换站点同文件路径警告、无二次确认弹窗。成功/错误用可访问反馈，支持深浅主题/窄屏，不新增设计系统依赖。
- [ ] **Step 6: 跑绿测试。** `npm --prefix frontend test -- --run`、`npm --prefix frontend run typecheck`、`npm --prefix frontend run lint`；共享Gofixture全部通过，原有登录/设置/图库tests正常。
- [ ] **Step 7: 仅获提交授权时提交。** `git add frontend/src/features/storage frontend/src/app/router.tsx frontend/src/features/auth frontend/src/features/settings/settings-page.tsx frontend/src/lib frontend/src/test/handlers.ts`；`git commit -m "feat: add first-run storage setup and fixed-mode settings"`。

### Task 8: 端到端契约、部署说明与最终验证

**Files:**
- Create: `internal/httpapi/imgbed_lifecycle_test.go`, `frontend/e2e/storage.spec.ts`
- Modify: `frontend/e2e/helpers.ts`, `frontend/e2e/accessibility.spec.ts`, `README.md`, `docs/api/admin.openapi.yaml`, `docs/api/images.openapi.yaml`
- Test: `internal/app/delivery_shutdown_test.go`, `internal/preview/preview_test.go`, `frontend/src/lib/schemas.test.ts`

**Interfaces:**
- Consumes前七任务接口；不新增生产API/preview模式/秘密环境变量。
- Go lifecycle测试使用SQLite + 注入safehttp transport的imgbed + mock Agnes/Edge；浏览器setup测试在已离线preview上用Playwright route拦storage API，不修改真实preview的已初始化local状态。

- [ ] **Step 1: 写跨层失败测试。** `TestImgbedSignedLifecycle` 完整生成后assert URL是本程序域名而非图床，验签GET/HEAD、b64原图、管理员下载、URL作为参考图、富化source失败后存储base64回退、单删后旧签名404；上传一次，不local落原图，不Token泄露。`TestShutdownDrainsImgbedDelivery` 阻塞图床回读后触发shutdown，预算内完成发布/富化后关闭，预算耗尽取消且不误删不确定候选。
- [ ] **Step 2: 写浏览器失败测试。** storage.spec沿preview登录：可见local只读模式；拦storage GET为未初始化验证setup刷新/键盘radio、375px无横向滚动、深浅主题；拦POST返回脱敏imgbed状态验证只发送指定字段并不回显Token；中途409→GET已初始化验证跳转。accessibility对setup/存储设置运行现有axe工具；不能真实请求图床或上传探测文件。
- [ ] **Step 3: 跑红测试。** `go test ./internal/httpapi ./internal/app -run 'ImgbedSignedLifecycle|ShutdownDrainsImgbed' -count=1`；`npm --prefix frontend run test:e2e -- storage.spec.ts`。若现有实现已满足某断言，则记录该测试首跑绿，不制造无关产品改动。
- [ ] **Step 4: 收敛集成差异并同步文档。** README更新schema4显式升级、首次登录/setup、固定方式、数据库含Token、两种备份范围、图床权限/公开读取/关闭过期、中国时区固定目录、地址更换不迁移、删除部分完成和孤立文件限制。OpenAPI新增storage三种状态/严格请求与错误码、初始化门禁；图片API保留签名结构，改存储说明与503原因。不得添加env示例Token或声称签名可控制图床公开副本。
- [ ] **Step 5: 跑完整本地验证。** 从repo根执行以下命令并保存各自exit code；先构建frontend满足Go embed，不把缺dist误判成Go功能错误：

```bash
npm --prefix frontend ci
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test -- --run
npm --prefix frontend run build
go test ./... -count=1
go vet ./...
npm --prefix frontend run test:e2e
```

预期全部exit0、无测试失败。检查Go格式用 `gofmt -l` 加本次变更的 `.go` 文件清单，预期无输出；仓库未配置Deno，不运行旧Deno记忆中的命令。检查Markdown/YAML/代码diff用 `git diff --check`，新文件还未stage时另跑 `git diff --no-index --check /dev/null <每个新文件>` 并区分diff exit1和格式错误。只格式化本次文件，不制造全库CRLF变更。
- [ ] **Step 6: 跑Linux race与镜像验证。** 在支持race的Linux/WSL环境运行 `go test -race ./... -count=1`；本机工具链不支持则明确记录跳过原因，不能声称race通过。运行 `docker build -t agnes-image-proxy:imgbed-check .` 仅构建、不push、不连接真实数据库；没有Docker时记录未验证。固定时区在distroless无tzdata仍正常，不为时区增加OS包。
- [ ] **Step 7: 自检约束与审查。** CodeGraph查询 original_ref/storage配置/原图调用链；搜索旧image_path仅可存在“拒绝旧schema/无旧列”测试，不存在兼容读取或生产fallback；审查锁顺序、网络凭据、DB短context、清理失败残留定位。按执行方式安排一次独立代码审查并处理已证实的问题，然后重跑受影响测试。
- [ ] **Step 8: 仅获提交授权时提交。** `git add README.md docs/api internal/httpapi/imgbed_lifecycle_test.go internal/app/delivery_shutdown_test.go frontend/e2e` 及实际集成修复文件；`git commit -m "test: verify ImgBed initialization lifecycle and deployment contract"`。不push、不执行真实reset，最终报告测试通过/失败/跳过及工作区状态。

## Self-Review and Handoff

- spec §1–6（初始化、不可变方式、配置/秘密、schema）→ Tasks 1/6/7。
- spec §7/11（精确上传、UTC+8、响应身份、网络边界）→ Tasks 2/3。
- spec §8/9（统一交付/参考图/富化/HEAD、更新并发）→ Tasks 4/6/8。
- spec §10（候选不确定性、单删、清空、reset）→ Tasks 4/5。
- spec §12（前后端契约、preview、测试与部署说明）→ Tasks 6/7/8。
- Review Focus 五项均有对应命名测试；接口名称、返回类型、脱敏字段和时区与 spec 一致。
- 顺序执行 Task 1→8；Task 2不依赖Task1的存储实现，但不为此另开多代理编排。Task4构造接口是破坏性变更，必须一次更新所有实际调用，不能留适配层。
- 未开始实施。执行方式留待实施时选择；按用户要求，文档设计无需再次请求用户审阅。
