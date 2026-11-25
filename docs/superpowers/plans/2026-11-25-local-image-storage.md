# 本地图片存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 原图和缩略图主要保存到 `/data` 本地文件，数据库只保存元数据和缩略图备份，避免相册读取远程原图 BLOB。

**Architecture:** 在现有 `internal/store` 内增加受限路径、原子写入的文件存储组件，仍由 `Store` 协调文件与 Turso 元数据。原图按随机 public_id 唯一保存，缩略图使用不可变版本文件和数据库路径指针，避免跨介质更新产生内容/MIME 不一致。通过图库级读写门和图片/输出级操作锁协调保存、读取、删除、清空；不跨远程请求全过程持有操作锁。

**Tech Stack:** Go 1.26.1 标准库、database/sql、现有 libSQL/Turso 驱动及 modernc SQLite 测试；React/Vite 不改变 UI。

**Spec:** `docs/superpowers/specs/2026-11-25-local-image-storage-design.md`（用户已批准）

## Global Constraints

- 原图存储到 `/data`；增加 `DATA_DIR` 环境变量，生产默认 `/data`。
- 缩略图也存储到 `/data`；数据库保留一份缩略图备份。
- 不兼容旧代码或旧数据，不做迁移或原图 BLOB 回退；schema 由 `2` 提升到 `3`。
- 单实例部署；图片目录和 Turso 是同一套备份/恢复数据，不支持多实例独立磁盘。
- 普通启动不自动删除真实数据；`reset-db --confirm` 才能重建并清理应用图片文件。
- `/data` 不作为无鉴权静态目录公开；保持现有签名、管理鉴权、no-store 和 HEAD 契约。
- 文件系统和数据库不能跨介质原子提交；不删除可能已成功提交的文件，可保留极端失败产生的孤立文件，不新增后台垃圾回收。
- 优先标准库，不新增依赖；预览和测试仅使用隔离临时目录。
- 不执行真实数据库 reset，不提交或推送，除非用户另行明确要求。各任务完成后保留可审阅的工作区检查点。

## Review Focus

- 数据库已提交但客户端返回超时/取消：重试不得覆盖或删除原图，base64 必须对应权威文件（Task 2）。
- 图片内容路径或子目录被替换成越界路径/符号链接：不得读写或清理应用目录以外的文件（Task 1）。
- 缩略图更新与读取/恢复交错：内容、MIME、字节数和备份必须属于同一版本（Task 3）。
- 删除/清空与保存、富化、恢复交错：不复活已删除图片，不误删清空后新保存图片（Tasks 2–3）。
- `/data` 不可写、卷持久化重启、配置的目录为空白：启动错误必须明确，重启后文件仍能读到（Tasks 1、4）。

---

## 文件责任与接口约定

- 新建 `internal/store/local_files.go`、`local_files_test.go`：应用专用 `images/` 子目录、受限路径文件操作、写入/同步/原子发布、删除、可写性检查。
- 修改 `internal/store/database.go`：组合文件存储、操作锁、构造函数和关闭资源。
- 修改 `internal/store/schema.go`：schema 3，移除 `image BLOB`，增加 `image_path TEXT` 与 `thumb_path TEXT`；保留 `thumb BLOB` 和现有 MIME/字节数；重建清理。
- 修改 `internal/store/gallery.go`、`image_content.go`：SQL 只取所需元数据，保存/读取/删除/富化协调。可将生命周期逻辑抽到 `gallery_files.go`，不要重构无关图库查询。
- 修改 `internal/config/config.go`、`cmd/agnes-proxy/commands.go`、`internal/preview/preview.go`：生产 DATA_DIR、预览临时路径、重建提示。
- 修改调用 `store.New` 的测试/夹具：显式传 `t.TempDir()`，处理构造失败；不得以旧签名或默认临时目录提供兼容层。
- 新建 `internal/store/local_gallery_test.go`、`local_thumbnail_test.go`：磁盘内容/失败/清理/并发契约。
- 修改 `Dockerfile`、`compose.yaml`、`.env.example`、`README.md` 和存在旧 BLOB/schema 描述的 API 文档：部署及新存储语义。

**内部文件接口（Task 1 产生）：**

```go
func newLocalFiles(dataDir string) (*localFiles, error)
func (f *localFiles) writeOriginal(ctx context.Context, publicID, mime string, data []byte) (string, error)
func (f *localFiles) writeThumbnail(ctx context.Context, publicID, mime string, data []byte) (string, error)
func (f *localFiles) read(ctx context.Context, path string) ([]byte, error)
func (f *localFiles) stat(ctx context.Context, path string) (int64, error)
func (f *localFiles) remove(path string) error
func (f *localFiles) removeImage(publicID string) error
func (f *localFiles) clear() error
func (f *localFiles) close() error
```

路径以应用专用目录为根，返回相对路径；原图 `publicID[:2]/publicID/original.<ext>`，缩略图 `publicID[:2]/publicID/thumb-<随机版本>.<ext>`。publicID 必须是 32 位小写十六进制；MIME 仅 png/jpeg/webp。创建目录 0750、文件 0640（Windows 不强断言 POSIX 权限）。采用 `os.Root` 限制路径逃逸；拒绝绝对/父目录路径。`read/stat` 保留 `errors.Is(err, os.ErrNotExist)`，其它 I/O 错误与缺失区分。

**Store 构造接口（Task 1 产生）：**

```go
func New(db *sql.DB, now func() time.Time, dataDir string) (*Store, error)
// store.Options 新增 DataDir string；Open 的签名不变，空值默认 /data。
```

Task 2–3 保持所有对外 Store 保存、读取、删除及富化方法签名不变；锁设计可由实现者细化，但禁止递归锁、清空时调用再次加锁的公开方法及对所有独立保存使用一把串行 SQL 锁。

### Task 1: 文件存储和运行路径

**Files:** 创建 `internal/store/local_files.go`、`local_files_test.go`；修改 `database.go`、config 及 config 测试、commands、preview、所有 `store.New`/包内 `New` 调用测试。

**Interfaces:** 产生上述文件接口和 Store 构造接口；Config 新增 `DataDir string`；现有存储方法此阶段仍使用现有 SQL，便于独立验证基础设施。

- [ ] **Step 1: 写失败测试**

`TestLocalFilesOriginalRoundTrip` 写 png 后断言返回相对路径、文件字节完全相同、stat 等于长度，目录没有未发布临时文件；`TestLocalFilesThumbnailVersions` 两次写返回不同路径，各自内容不变。

```go
if !bytes.Equal(got, input) || size != int64(len(input)) { t.Fatal("file round trip") }
if firstPath == secondPath { t.Fatal("thumbnail version overwritten") }
```

`TestLocalFilesRejectUnsafePaths` 表驱动传 `../outside`、绝对路径、非法 publicID；所有操作报错且外部 sentinel 不变。可创建符号链接的平台测试应用内部指向外部的链接；无法创建链接则明确 skip。`TestLocalFilesClearOwnsOnlyNamespace` 清理后 `/data/keep.txt` 保持原样。`TestLocalFilesCanceledWrite` 取消请求不留下已发布/临时文件。`TestLocalFilesUnwritableRoot` 用普通文件占据目标目录，构造失败；不依赖 root 的 chmod 行为。

Config 测试断言 `cfg.DataDir == "/data"`，自定义绝对目录原样使用；显式空白的 DATA_DIR 报错，不默默写当前目录。Preview 测试断言关闭前文件可读、关闭后临时根已删除。

- [ ] **Step 2: 验证测试先失败**

运行 `go test ./internal/store ./internal/config -run 'TestLocalFiles|TestConfig.*DataDir' -count=1`，预期缺少新接口/字段而失败。

- [ ] **Step 3: 实现文件存储接口**

使用同目录 CreateTemp、写入、Sync、Close、Rename；所有失败清理临时文件，原图路径不得覆盖已有权威原图。初始化创建并检查应用目录可写。定义文件错误为可分类的本地存储错误，不泄漏绝对路径到 API。`close` 关闭 os.Root；`clear` 只清理自有 images 内容，保持根句柄可继续使用。

- [ ] **Step 4: 接入构造、配置与隔离路径**

`New` 失败不关闭调用者传入的 db；`Open` 构造失败关闭自己创建的 db。Close 关闭 SQL 和文件根。生产 serve/reset 将 cfg.DataDir 传入 Options；preview 使用 `filepath.Join(dir, "data")`。统一更新测试构造调用，不创建兼容旧签名；配置默认/空白处理按 Step 1。

- [ ] **Step 5: 验证并保存检查点**

运行 `go test ./internal/store ./internal/config ./internal/preview ./cmd/agnes-proxy -count=1`，预期全部 PASS。检查 diff，无意外真实 data 文件；不提交。

### Task 2: 原图本地化和完整生命周期

**Files:** 修改 `internal/store/schema.go`、`schema_test.go`、`gallery.go`、`image_content.go`、`image_content_test.go`、`logs_gallery_test.go`、`recovery_test.go`；创建 `local_gallery_test.go`；按需创建 `gallery_files.go`。现有 service/httpapi 测试中的原图 BLOB SQL 假设一并更新。

**Interfaces:** 消费 Task 1；schema 3 新字段 `image_path`/`thumb_path`。保持 SaveGeneratedImage、SaveDeliveryImage、InsertGallery、ImageInfo、PublicImageInfo、PublicImageContent、GalleryContent、DeleteGallery、ClearGallery、ResetSchema 的对外签名。

- [ ] **Step 1: 写失败测试和更新 schema 契约**

`TestLocalGalleryOriginalNotInDatabase` 查询 pragma 断言不存在 `image`、存在 `image_path`，保存后读取磁盘和公开内容都等于输入；schema 标识为 `3`、schema 2 启动拒绝且不修改旧表。旧 BLOB rollback 测试只对 `thumb` 备份验证。

`TestLocalGalleryDeduplicatesChangedBody` 和并发重复写：仅一条 output_key、一个权威原图，第二次内容改变不覆盖；两种交付格式相同。沿用并扩展 `TestDeliveryAmbiguousWriteChangedBodyUsesStoredBase64`、`TestDeliveryCanceledAmbiguousCommitKeepsOriginal`，断言磁盘仍存在。

`TestLocalGalleryFileFailureDoesNotPublishRow` 文件路径被普通文件阻塞，保存失败且 gallery 行数为零。`TestLocalGalleryAmbiguousInsertKeepsFile` 使用故障 SQL 驱动/现有 ambiguous seam 模拟提交后返回错误，确认后续重试可读取原图；若只包装服务回写则需额外测试 Store 对 SQL 错误不主动删除候选文件。

`TestLocalGalleryMissingOriginal` 移除文件后 GET/HEAD 不报告成功，不回源下载。`TestLocalGalleryDeleteClearReset` 断言单删移除图片目录、清空移除孤立文件、确认 reset 清账号/设置/日志/图片；未确认 reset 与旧 schema 启动不得删文件；无关 sentinel 保持。`TestLocalGalleryClearWaitsForSave` 用受控写入/SQL 阻塞协调并发保存与清空，确认结果对应一个合法串行顺序，清空后的新图可读。

- [ ] **Step 2: 验证测试先失败**

运行 `go test ./internal/store ./internal/service -run 'TestLocalGallery|TestSchema|TestDelivery.*Ambiguous|TestDeliveryCanceledAmbiguous' -count=1`，预期本地存储/schema 断言失败。

- [ ] **Step 3: 实现 schema 3 和原图发布**

insertGallery 写原图文件后插入小型元数据（不把 insert.Image 传入 SQL）；保留随机身份和 output_key 去重。确认去重时清理本次无引用候选文件，数据库错误/提交结果不明时保留候选文件。重复输出必须返回现有记录/原图，不修复缺失原图或覆盖它。SaveDeliveryImage 的保存与权威内容读取纳入同一图库操作生命周期。

- [ ] **Step 4: 实现本地原图读取与清理**

ImageInfo/PublicImageInfo 查询小型元数据且 stat 文件验证可读身份/长度，HEAD 不读全部内容；PublicImageContent/GalleryContent 原图仅按受限路径读文件。保留图库源查询的小型元数据及 archived 状态；InsertGallery 可继续为内部种子创建无原图行，不引入生产旧数据兼容。

图库级 gate：普通内容操作/保存/富化/单删共享，clear/reset 独占；图片级锁协调删除、富化和缩略图恢复，输出级锁用于去重。删除数据库记录和文件，缺失文件可视为已清理；真实 I/O 错误必须返回错误。数据库删成功但文件删失败可能留下孤立文件，清空可清理。ResetSchema 在明确确认下执行新 schema 重建和本地清理，内部 helper 避免递归锁；数据库结果不明确不得主动清理可能被引用的原图。

- [ ] **Step 5: 验证并保存检查点**

运行 `go test ./internal/store ./internal/service ./internal/httpapi -count=1`，预期 PASS。重点复跑签名、HEAD、同源引用和 delivery 测试，检查无 `SELECT image`/原图 BLOB SQL 残留（用 CodeGraph 定位改动符号，必要时精准搜索非索引 SQL）。不提交。

### Task 3: 本地缩略图、备份和恢复

**Files:** 修改 `internal/store/gallery.go`/`gallery_files.go`、`image_content.go`、`logs_gallery_test.go`；创建 `local_thumbnail_test.go`；更新 Edge/HTTP 测试的磁盘断言。

**Interfaces:** 消费 Tasks 1–2；保持 SetEnrichment(ctx, id, domain.EnrichmentWrite) error 与 GalleryContent(ctx, id, thumbnail) 签名，使用 schema 3 `thumb_path` 指针。

- [ ] **Step 1: 写失败测试**

`TestLocalThumbnailWritesFileAndBackup` SetEnrichment 后磁盘和 `SELECT thumb` 内容相同，MIME/长度一致。`TestLocalThumbnailReadDoesNotSelectBackup` 将数据库 thumb 备份替换为不同字节但保持小型元数据，正常读取仍返回本地原内容。

`TestLocalThumbnailMissingRestoresBackup` 删除本地缩略图，读取返回备份且重新落盘；第二次读取不依赖备份。`TestLocalThumbnailRestoreWriteFailsStillReturnsBackup` 受控故障让 read 返回 os.ErrNotExist、恢复写入失败，仍返回有效备份；`TestLocalThumbnailNonMissingReadError` 非缺失 I/O 错误不能被备份掩盖。

`TestLocalThumbnailVersionMatchesMIME` 并发 png/webp 更新和读取，每份数据的 SniffImage 必须等于返回 MIME，长度等于对应元信息。`TestLocalThumbnailFailedUpdateKeepsPriorVersion` SQL 失败保留旧指针/旧文件；结果不确定保留新候选文件。`TestLocalThumbnailDeleteDuringEnrichmentOrRestore` 用通道协调删除/清空与恢复/SetEnrichment，结束后无复活记录/文件。不存在的 id SetEnrichment 不写文件且维持 no-op；失败状态不清除已有 thumbnail。

- [ ] **Step 2: 验证测试先失败**

运行 `go test ./internal/store -run TestLocalThumbnail -count=1`，预期本地缩略图/恢复断言失败。

- [ ] **Step 3: 实现版本化保存与备份**

SetEnrichment 在图片级操作锁内确认记录存在，写不可变版本文件，再将 thumb_path、thumb 备份、thumb_mime、thumb_bytes 和富化状态合并到一次 SQL UPDATE。确认成功才删除旧版本；数据库错误/结果不明确保留所有可能被引用的文件。不持锁调用外部 Edge 服务。有效 MIME/体积限制遵循现有 Edge 逻辑。

- [ ] **Step 4: 实现本地优先与恢复**

GalleryContent 缩略图先查询 thumb_path/MIME/长度等小型元信息，读本地；仅 os.ErrNotExist 时读取该版本数据库备份。恢复与 SetEnrichment/delete 使用同一操作协调，不对已删除行写文件；恢复写失败可返回备份，但返回前不得绕过已有读取错误分类。删除该图片目录会一并清理所有缩略图版本和候选文件。

- [ ] **Step 5: 验证并保存检查点**

运行 `go test ./internal/store ./internal/service ./internal/httpapi ./internal/preview -count=1` 和 `go test -race ./internal/store ./internal/service ./internal/httpapi -count=1`，预期 PASS。race 若当前平台不具备可用 C toolchain，记录原因并尝试已安装的 Linux/WSL 工具链，不声称已通过未运行的 race。不提交。

### Task 4: 部署持久化、文档与整体验证

**Files:** 修改 `Dockerfile`、`compose.yaml`、`.env.example`、`README.md`、`cmd/agnes-proxy/commands.go`/测试；更新 `docs/api/images.openapi.yaml`、`admin.openapi.yaml` 中实际存在的旧 BLOB 描述。

**Interfaces:** `/data` 为镜像可写挂载点，Compose 顶层命名卷 `image-data`，服务挂载 `image-data:/data` 并固定 `DATA_DIR: /data`；非容器可配置绝对 DATA_DIR。继续 distroless nonroot 和 read_only。

- [ ] **Step 1: 写部署/命令失败测试**

commands 测试确认 reset 未带 --confirm 时不连接数据库、不初始化/清理目录；帮助和成功提示明确涉及图片文件。补充文件存储重开测试：保存、关闭 Store、使用同一数据库/目录重开后原图和缩略图仍完全一致（`TestLocalGalleryReopenPersistsContent`）。Docker 可用时以命名卷启动镜像，验证 nonroot 身份可写 `/data`、只读根不能写其它位置、容器重建后卷内容保留。

- [ ] **Step 2: 验证测试先失败**

运行上述命令测试和 reopen 测试，预期旧提示或缺少部署挂载检查失败；明确哪些属于配置审查而非自动化测试。

- [ ] **Step 3: 更新部署与文档**

Docker 构建阶段创建 /out/data 并在最终阶段 `COPY --chown=65532:65532` 到 /data，提供挂载目录，继续 USER nonroot。Compose 加命名卷和 DATA_DIR。`.env.example` 加默认 `/data` 说明。README 更新 schema 3、本地存储、缩略图备份、数据库+卷一起备份、单实例限制、磁盘空间、清理失败和重建影响；docker run 示例加命名卷，非容器开发示例给 DATA_DIR。明确升级需空库或停服后显式 reset，禁止在运行服务时执行 reset（进程内锁不协调外部 CLI）。不执行真实 reset。

- [ ] **Step 4: 整体验证**

运行 `gofmt` 于改动 Go 文件、`git diff --check`；运行 `go test ./... -count=1`、`go vet ./...`；运行 `npm --prefix frontend run test -- --run`、`npm --prefix frontend run build` 和 `npm --prefix frontend run lint`。前端构建必须在需要 go:embed 的全量 Go 编译前完成（若资产已存在，可先跑 targeted 测试）。可用时运行 `npm --prefix frontend run test:e2e` 和 `docker compose config`、Docker build/卷权限验证；环境缺项明确报告，不把未执行算通过。

- [ ] **Step 5: 独立代码审阅和交付**

请一名独立审阅者检查整个 diff，对照 Spec 和 Review Focus；确认缺陷后先补失败测试再修复并复跑相关测试。最终报告 schema 破坏性变更、卷配置、实际运行的验证和未运行项，列出关键文件；不提交/推送，不删除用户已有旧数据库或卷。

## 计划自检

- 需求覆盖：目录/配置 Task 1，原图/鉴权读取/去重/删除/重建 Task 2，缩略图备份和一致恢复 Task 3，部署/文档/全量验证 Task 4。
- 类型一致：文件接口在 Task 1 定义，各 Task 保持对外 Store 方法签名，唯一构造破坏性改动由 Task 1 更新全部调用。
- Review Focus 五类均在对应任务有命名测试；没有 UI 改造、多实例支持、旧数据迁移、真实 reset 或未经要求的 git 提交。
- 任一任务完成前必须先看到所新增行为测试失败，再实现并复跑；现有测试因删掉原图字段而修改不替代新行为测试。
