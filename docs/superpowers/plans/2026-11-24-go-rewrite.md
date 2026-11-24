# Go 后端与 React 控制台重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 Go 后端和 React 控制台完整替换 Deno 项目，保留图片代理与管理能力，通过单 Docker 服务连接 Turso。

**Architecture:** Go 标准库 HTTP 服务负责认证、图片协议、账号调度、存储与受管理后台任务。React/Vite 负责管理页面，构建产物由 Go embed 同源提供；数据库仅初始化新契约，不兼容旧版本。按底层契约→服务编排→管理 UI→部署验收顺序实施，离线 SQLite 与模拟 HTTP 服务验证边界。

**Tech Stack:** Go 1.26、database/sql、Go libSQL HTTP 驱动、modernc.org/sqlite（离线测试/preview）、Node 24 LTS、npm、React/TypeScript、Vite、Tailwind CSS、shadcn/ui（Radix）、TanStack Query、React Router、Zod、Lucide、Vitest/Testing Library/MSW、Playwright/axe、Recharts（总览折线）。具体兼容版本在实施时锁定，不使用未锁定的 latest 镜像或依赖。

**Spec:** `docs/superpowers/specs/2026-11-24-go-rewrite-design.md`

## Global Constraints

- 后端业务与生产运行服务完全使用 Go；浏览器前端使用 React/TypeScript。
- 开发与构建需要 Go 及 Node/npm，Docker 最终运行镜像中无需 Deno、Node 或前端构建工具。
- 不兼容旧程序、旧数据库或旧设置；不实现迁移、双写、旧字段转换、旧实现回退。
- 继续使用远程 Turso 数据库，图片和缩略图仍保存为数据库 BLOB。
- 默认返回 `url`；显式 `response_format=b64_json` 或 `return_base64=true` 可请求 base64。
- 限制 16 张、单张 20 MiB、总请求体 32 MiB；客户端 `n` 保持正整数、不新增任意最大值。
- 上游单次 `n=1`；默认上游超时 300 秒，可配置 60—360 秒。
- 全失败按 `429 > 504 > 502 > 503` 聚合最终错误；同级 429 选较短、封顶 900 秒的 Retry-After。
- 数据库超时 15 秒；输出下载上限 64 MiB、60 秒；参考图头最多 1 MiB、10 秒、2 次重定向。
- Edge-Images 元数据超时 10 秒；富化每批最多 20 项，base64 源字节预算 32 MiB，单张 base64 超过 50 MiB 不发送；URL 不计入字节预算。
- 签名会话 30 天，剩余不足 7 天的管理 API Cookie 请求续期，总寿命最长 90 天。
- UI 普通文字至少 4.5:1；交互目标至少 44×44px、相邻目标至少 8px；基础字号 16px、行高至少 1.5，次要元数据不小于 12px。
- UI 验收宽度 375/768/1024/1440px；微交互通常 150—200ms，尊重 prefers-reduced-motion。
- 不自动提交、推送、发布镜像、部署或消耗真实 Agnes 额度。每任务用可审查 diff 作检查点；只有用户另行要求后才提交。
- 未获得额外授权，不访问/重置真实 Turso、不运行真实 Agnes smoke；缺少 Docker/race/browser 工具时如实标注，不以别的测试代替。

## Review Focus

1. 大 `n` 与慢归档同时出现：新请求先获取可取消容量，上游调用受全局并发控制，不无限创建 goroutine，不静默丢弃已成功图；Task 8/10 验证。
2. 客户端取消与服务退出交叉：未发起调用停止，已接受归档在退出预算内完成，预留容量不会泄漏或触发 send-on-closed-channel；Task 8/10/16 验证。
3. 快速切换图片/筛选后旧响应迟到：旧图不能闪回、新筛选不得混入旧列表、对象 URL 释放；Task 13 验证。
4. Cookie 经 TLS 反代而伪造 X-Forwarded-*：仅信任配置代理，跨站变更拒绝，401 清缓存，重新登录后不显示前次会话数据；Task 9/12/16 验证。
5. 浏览器深链接刷新、未知 API 与丢失静态资源：页面可刷新，API 404 不变成 HTML，hash 资源缓存与敏感内容 no-store 分开；Task 2/11/16 验证。

---

## 实施准备与文件边界

本项目是耦合的全量替换，不拆成可独立部署的多个产品。此计划分成存储/图片后端、HTTP 服务、React 控制台、交付四个阶段；每项都有独立离线验收。执行时先按 using-git-worktrees 创建隔离工作区或开发分支，保留主工作区未跟踪的 `.codegraph/` 和本次文档，不自动提交。使用 CodeGraph 理解旧契约后再修改；旧代码只作为行为参考，不复用兼容逻辑。

| 路径 | 职责 |
|---|---|
| `internal/domain/{settings,accounts,images,logs,gallery}.go` | 少量跨模块业务类型，JSON 用 camelCase；OpenAI 响应用协议 snake_case |
| `internal/apierror/error.go` | HTTP 状态、OpenAI 错误信封、公共错误码 |
| `internal/config/config.go` | 环境变量、资源限制与启动校验 |
| `internal/store/{database,schema,settings,accounts,logs,usage,gallery,auth}.go` | 同一 database/sql 存储实现 |
| `internal/testutil/{sqlite,images}.go` | 离线数据库与合法 PNG/JPEG/WebP 测试素材 |
| `internal/images/{size,parse,multipart,dimensions,remote,normalize}.go` | 输入协议、尺寸及受控下载 |
| `internal/agnes/{client,pool,failures}.go` | Agnes 请求、重试与错误聚合 |
| `internal/service/{images,edge,metadata,enrich,tasks,archive,backfill,probe}.go` | 编排、容量与任务生命周期 |
| `internal/auth/{secret,session,limiter}.go` | 认证和会话 |
| `internal/httpapi/{router,middleware,auth,images,accounts,settings,logs,overview,gallery,assets}.go` | HTTP 边界，不放业务调度逻辑 |
| `internal/webassets/assets.go` | `//go:embed dist`，无占位 fallback |
| `frontend/src/{app,components,features,lib,test}/` | 框架/设计组件、六个页面、类型化 API、测试 |
| `cmd/agnes-proxy/{main,commands}.go` | serve/preview/healthcheck/reset-db |
| `internal/preview/preview.go` | 明确启用的 SQLite + 模拟上游，不是生产故障回退 |
| `design-system/agnes-console/MASTER.md` | 已验证主题 token、控件规则与验收记录 |
| `Dockerfile`, `compose.yaml`, `.env.example`, `.dockerignore`, `.gitignore`, `README.md` | 构建、运行、密钥隔离、开发/部署说明 |

所有 Go 文件旁边创建对应 `_test.go`。测试仅访问测试提供的 HTTP/DNS fixture，不因为使用 production 模式连接真实服务。Web 测试数据来自 MSW 或 preview。

### 跨任务共享约定

- Go module：`github.com/NooAcc/Agnes-Image-Proxy`（如仓库实际远程 owner 不同，在 Task 1 用 `git remote -v` 校正一次，并同步 imports）。Go 包不导入前端类型，也不生成第二套模型兼容层。
- domain 时间使用 `time.Time`，存库 RFC3339Nano UTC；传输 RFC3339 UTC。SQL 时钟用注入 `func() time.Time`，不用 sleep 测试冷却。
- `domain.Settings`：`AgnesBaseURL string`, `DefaultSize string`, `ImageParamMode string`, `ProbeModel string`, `ProbeConcurrency int`, `RequestTimeoutMS int`, `AutoRefreshIntervalMS int`, `MaxAttempts int`, `ImageServiceBaseURL string`, `ThumbnailWidth int`, `ThumbnailQuality int`, `EnrichTimeoutMS int`；不包含固定的 defaultResponseFormat。
- `domain.Account` 包含 ID/name/APIKey/enabled/status/cooldown/failCount/lastUsedAt/upstreamRequests/upstreamImages/createdAt；APIKey 为内部字段且 `json:"-"`。`domain.ClaimedAccount` 包含 ID/name/APIKey/FailCount。`domain.AccountSummary` 独立包含 `apiKeyMasked`，不能嵌入带密钥的可序列化类型。
- `domain.PixelSize{Width,Height int}`，`domain.ResolvedSize{Mode,Tier string; Ratio *string; DerivedRatio string; Expected PixelSize; Exact *PixelSize}`。
- `domain.ImageRequest{Endpoint,Model,Prompt string; N int64; Size ResolvedSize; ResponseFormat string; Images []string; Warnings []string; ExtraBody map[string]json.RawMessage}`；N 用 int64，拒绝机器表示范围外的数，不以业务上限截断。
- `domain.OutputImage{URL,Base64 *string}`，响应另有 `revised_prompt:null`；`domain.Measurement{Size *PixelSize; Format *string}`；`domain.GeneratedImage{Image OutputImage; Measurement Measurement; AccountID int64; AccountName string}`。
- `domain.Attempt` 与 `domain.SubrequestTrace` 固定记录 index/account/status/code/duration/message；`domain.RequestLog` 固定 requestId/ts/category/stage/endpoint/path/model/status/ok/requested/images/failed/sizeRequest/sizeActual/attempts。account/prompt 等敏感业务字段遵循 spec，不把密钥或 BLOB 写日志。
- `domain.NSFWScores{Drawing,Hentai,Safe,Porn,Sexy float64; IsNSFW bool}`；分数必须有限且在 0—1；tag tie 顺序 safe/drawing/sexy/porn/hentai。
- `domain.GalleryItem` 是不含 BLOB 的摘要；`domain.GallerySource` 包含 ID/sourceURL/MIME/bytes/sourceBytes；`domain.GalleryInsert` 带请求、模型、prompt、尺寸、来源、原图；`domain.EnrichmentWrite` 带 thumb/MIME/scores/tag/status/error/at。
- `domain.CursorQuery{Before *int64; Limit int; Tag,Category string}`；`domain.Page[T]{Items []T; NextBefore *int64}`，limit 默认图库 24、日志 50、上限 100。未知 tag/category、非法游标返回 400。
- `domain.Overview{StartDay,EndDay string; Totals UsageTotals; Days []DailyUsage; Models []ModelUsage; Accounts AccountHealth}`；每日缺项补 0；日期为 UTC `YYYY-MM-DD`。
- `apierror.Error{Status int; Message,Type string; Param,Code *string; Headers http.Header}` 实现 error。`apierror.Write(w,error)` 不回显数据库/秘密 transport 信息。
- `store.Open(ctx, store.Options{URL,AuthToken string; Timeout time.Duration}) (*store.Store,error)`；`store.New(db *sql.DB, now func() time.Time) *store.Store`；`store.Close() error`。
- `agnes.AccountRepository` 定义 `Claim(context.Context,[]int64)(*domain.ClaimedAccount,error)`、`RecordSuccess(context.Context,int64,int64,int)error`、`RecordFailure(context.Context,int64,time.Duration)error`；`agnes.Generator` 定义 `Generate(context.Context,string,string,map[string]any,time.Duration)(json.RawMessage,error)`，Store/Client隐式实现，不能在别包重复定义参数不同的版本。
- `auth.EpochStore` 定义 `SessionEpoch(context.Context)(int64,error)` 与 `BumpSessionEpoch(context.Context)(int64,error)`；time.Now只在程序组装注入，测试用固定时钟。
- `domain.AccountPatch{Name,APIKey *string; Enabled *bool}`；`domain.UsageTotals{Requests,Successes,Partials,Failures,Images int64}`，`DailyUsage{Day string; UsageTotals}`、`ModelUsage{Model string; UsageTotals}`、`AccountHealth{Total,Healthy,Cooling,Disabled int}`。`service.ProbeResult{ID int64; OK bool; Status int; Message string}`，JSON为id/ok/status/message。
- 跨模块 `domain.LogQuery`/`CursorQuery` 如无必要不增第二份；`Options` 以本任务依赖的具体Store/服务指针组织，只有测试替换网络、时钟、存储的边界使用上述窄接口。
- 前端类型化客户端 `api<T>(path:string, options?:RequestInit):Promise<T>`，统一同源 Cookie、AbortSignal、ApiError。Go JSON 与 `frontend/src/lib/contracts.ts` 一一对应，新增字段先改契约测试，不用 `any` 掩盖不一致。

## Phase A：基础与核心业务

### Task 1：可测试的新数据库契约与配置

**Files:** Create `go.mod`, `go.sum`, `internal/apierror/error.go`, `internal/config/config.go`, `internal/domain/settings.go`, `internal/store/{database,schema,settings}.go`, `internal/testutil/sqlite.go`; Test 对应 `_test.go`。

**Interfaces:** Produces `config.Load(getenv func(string) string)(config.Config,error)`、`store.Open/New/Close`、`Store.EnsureSchema(ctx) error`、`Store.ResetSchema(ctx, confirmed bool) error`、`domain.DefaultSettings() Settings`、`domain.ValidateSettings(Settings)(Settings,error)`、`Store.ReadSettings(ctx)(Settings,error)`、`Store.WriteSettings(ctx,Settings) error`、`testutil.OpenDB(t *testing.T)*sql.DB`。

- [ ] **Step 1 — 写失败测试。** `TestConfigRequired` 检查三个必需 env 空值拒绝；端口默认 8000、非法/越界拒绝；CORS 只接受完整 origin，拒绝 path/userinfo/query。`TestEnsureSchemaRejectsNonEmptyWithoutMutation`：建旧 accounts 表并插行，初始化失败且原表/行数不变。`TestSchemaReopenAndBlobTransaction`：新 schema 重开成功，事务 rollback 不留数据，含 0x00/0xff BLOB 往返相同。

```go
func TestSettingsDefaults(t *testing.T) {
    s := domain.DefaultSettings()
    if s.DefaultSize != "1K" || s.MaxAttempts != 3 || s.RequestTimeoutMS != 300000 || s.ThumbnailWidth != 640 || s.ThumbnailQuality != 75 || s.EnrichTimeoutMS != 60000 {
        t.Fatalf("wrong defaults: %+v", s)
    }
}
```

- [ ] **Step 2 — 运行 RED。** `go test ./internal/config ./internal/store ./internal/domain`；预期缺模块/符号或未实现断言失败，不把依赖下载失败当作 RED。
- [ ] **Step 3 — 实现。** 先验证 `github.com/tursodatabase/libsql-client-go/libsql` 的当前模块文档/源码与兼容 Go 版本，锁定驱动；验证 database/sql 事务、context 取消、远程 authToken、`UPDATE RETURNING` 和 BLOB 的公开接口。离线用 mock transport 证明 driver 协议；若驱动无法注入 transport，在单独驱动协议 fixture 测试中拦截其连接，不改成另一套业务 SQL。Turso URL 允许 libsql/https，拒绝 credentials、path/query/hash；不在 URL/日志打印 token。连接失败/超时归一成 503；内部错误仅输出脱敏诊断。
- [ ] **Step 4 — 建完整新 schema。** 单个事务先检查所有非系统用户表，再创建 `app_meta`（application=`agnes-go`、schema=`1`）、accounts/settings/auth_state/request_logs/model_usage_daily/gallery 与索引；不在拒绝旧库前创建元数据。settings 单行 JSON 保存已验证新结构；epoch 默认 1。重开验证 application/version 及所需表/列，不自动修复损坏/不完整 schema。Reset 必须 confirmed=true，且只处理明确的本应用表，不遍历删除未知表。
- [ ] **Step 5 — 固定默认值与范围。** Agnes URL `https://apihub.agnes-ai.com/v1`，probeModel `agnes-image-2.5-flash`，probeConcurrency=2（1—10），refresh=5000ms（2000—60000），maxAttempts=3（1—10）；timeout 60000—360000，thumb width 128—2048、quality 40—100、enrich timeout 5000—60000。校验 URL 不含 userinfo/query/hash；HTTP 仅 localhost。配置资源初值 MaxInFlight=8、ArchiveWorkers=4、ArchiveCapacity=32、ShutdownTimeout=120s，均 >0，容量不得小于 worker 数；Task 16 文档公开这些实现者默认值。
- [ ] **Step 6 — GREEN 与检查点。** `go test ./internal/config ./internal/store ./internal/domain && go vet ./internal/config ./internal/store`；加入 15 秒取消、非空旧库、版本错误、未知 settings 字段拒绝及 reset 未确认不改库测试；检查 diff，不提交。

### Task 2：React 应用基础、主题与 Go 静态资源边界

**Files:** Create `frontend/{package.json,package-lock.json,tsconfig.json,vite.config.ts,vitest.config.ts,eslint.config.js,components.json,index.html}`, `frontend/src/{main.tsx,app/router.tsx,app/providers.tsx,app/shell.tsx,app/theme.tsx,styles/tokens.css,styles/global.css,lib/contracts.ts,lib/api.ts,lib/query-keys.ts,test/setup.ts}`, `frontend/src/components/ui/*`, `internal/webassets/assets.go`, `internal/httpapi/assets.go`, `design-system/agnes-console/MASTER.md`; Modify `.gitignore`; Test `frontend/src/app/shell.test.tsx`, `internal/httpapi/assets_test.go`。

**Interfaces:** Produces `webassets.FS()(fs.FS,error)`、`httpapi.NewAssets(fs.FS) http.Handler`，React `AppProviders`/`AppShell`、`ThemeProvider`/`useTheme`、`api<T>` 与 QueryClient。URL 结构与 spec §11 一致；此阶段路由可渲染有标题/导航的页面容器，业务页面在后续替换，不交付伪造统计。

- [ ] **Step 1 — 写失败测试。** `shell.test.tsx`：system 初次主题、切换 dark 后重载保持 dark，移动导航可键盘打开/关闭且恢复焦点；图标按钮均有 accessible name。Assets：`GET /admin/gallery` 返回 index，`GET /admin/assets/missing.js` 返回 404 而非 HTML，未知 API 不落入 assets fallback，HEAD 无 body。
- [ ] **Step 2 — RED。** 建立测试所需 package 清单、Vitest/jsdom/Testing Library 配置再执行 `npm --prefix frontend run test -- --run src/app/shell.test.tsx`；预期缺组件/行为失败。
- [ ] **Step 3 — 实现框架。** 安装并锁定 React/Vite/Tailwind/shadcn Radix/Query/Router/Zod/Lucide；仅添加 Button/Field/Input/Dialog/AlertDialog/Sheet/Select/Table/Badge/Skeleton 等实际用到的组件。Vite base `/admin/`、outDir `../internal/webassets/dist`，Router basename `/admin`；Node 24 与 npm lockfile。初期预置已定义的 DTO TS 类型，后续 Task 11 用 fixture 验证。
- [ ] **Step 4 — 实现主题与 shell。** tokens 分 primitive/semantic/component，系统中文字体、44px 目标、focus ring、150—200ms 反馈、reduced-motion；桌面侧栏/移动 Sheet，main landmark、跳过导航、页面标题。运行 ui-ux-pro-max 相关栈/UX 查询，采用适配 dashboard 的规则；只把已验证的色值、间距、字号、组件规则保存 MASTER，不持久化营销搜索结果。对比度测试给出明暗主题 normal text >=4.5、非文本 >=3 的计算结果。
- [ ] **Step 5 — 实现 assets。** Go embed不含占位目录；构建之后再跑Go assets测试。Go route仅在已知页面GET/HEAD退回index，路径清理/穿越/未知资源拒绝；CSP `script-src 'self'`无unsafe-inline/eval、`style-src 'self'`、仅`style-src-attr 'unsafe-inline'`支持React/Radix/Recharts的动态style属性，img-src self blob: data:，不放宽任意内联脚本/stylesheet。index no-store、hash资源immutable、其余不长缓存；浏览器E2E断言Dialog/Select定位和图表style无CSP违规。
- [ ] **Step 6 — GREEN 与检查点。** `npm --prefix frontend run typecheck && npm --prefix frontend run lint && npm --prefix frontend run test -- --run && npm --prefix frontend run build && go test ./internal/httpapi ./internal/webassets`。node_modules/dist 忽略，密钥/.env 忽略；不提交产物。

### Task 3：账号原子调度存储与设置读写

**Files:** Create `internal/domain/accounts.go`, `internal/store/accounts.go`; Extend `internal/store/settings.go`; Test `internal/store/{accounts,settings}_test.go`。

**Interfaces:** Consumes Task 1 Store/defaults。Produces `Store.ListAccounts(ctx)([]domain.AccountSummary,error)`、`GetAccount(ctx,id)(domain.Account,error)`、`CreateAccount(ctx,name,key)(domain.AccountSummary,error)`、`UpdateAccount(ctx,id,domain.AccountPatch)(domain.AccountSummary,error)`、`DeleteAccount(ctx,id)(bool,error)`、`Claim(ctx,exclude []int64)(*domain.ClaimedAccount,error)`、`RecordSuccess(ctx,id,expectedFailCount int64,images int)error`、`RecordFailure(ctx,id int64,cooldown time.Duration)error`、`ResetHealth(ctx,id)(bool,error)`。AccountPatch name/key/enabled 均指针，空 APIKey 不修改旧值。

- [ ] **Step 1 — 写失败测试。** `TestClaimRoundRobinAtomic` 在 3 账号并发 claim 后 selection sequence 单调且健康账号轮流使用；disabled/cooling/excluded 不选。`TestSuccessDoesNotEraseConcurrentFailure` 先 claim，写失败，再用旧 FailCount 成功回写，冷却保留且成功调用/图片计数增加。`TestMaskNeverSerializesAPIKey` JSON 不含完整 Key、字段 apiKey 不存在。settings 写后立即读新值，非法更新 rollback。
- [ ] **Step 2 — RED。** `go test ./internal/store -run 'Test(Claim|Success|Mask|Settings)' -v`，预期缺方法/错误状态。
- [ ] **Step 3 — 实现。** 使用一个 `UPDATE ... WHERE id=(SELECT ... ORDER BY use_seq,id LIMIT 1) RETURNING ...` claim，不以先 SELECT 后 UPDATE 替代；sequence 在事务/SQL 中全局单调，exclude 占位符参数绑定。RecordSuccess CAS 仅控制健康/失败清零，不抹去成功统计；失败计数原子增加，冷却不得被并发较短失败缩短。删除时保留日志/gallery 的账号快照（ID 可为空），不级联删历史图片。
- [ ] **Step 4 — GREEN 与检查点。** `go test ./internal/store -count=10`；覆盖重复账号名、非法 key、空 key edit、不存在 ID、disabled 后继续历史展示、冷却到期可选；数据库错误保持 Task 1 分类。

### Task 4：输入协议、原生尺寸和受控图片网络访问

**Files:** Create `internal/domain/images.go`, `internal/images/{size,parse,multipart,dimensions,remote,normalize}.go`, `internal/testutil/images.go`; Test 对应 `_test.go`。

**Interfaces:** Produces `images.Parse(ctx, r *http.Request, defaults domain.Settings, reader images.ReferenceReader)(domain.ImageRequest,error)`、`ResolveSize(size,ratio string,reference *domain.PixelSize,defaultTier string)(domain.ResolvedSize,error)`、`Payload(req domain.ImageRequest,mode string)(map[string]any,error)`、`Normalize(raw json.RawMessage)([]domain.OutputImage,error)`、`NewRemote(options RemoteOptions)*Remote`、`Remote.Dimensions(ctx,url)(domain.PixelSize,error)`、`Remote.Download(ctx,url)([]byte,string,error)`。ReferenceReader=`Dimensions(context.Context,string)(domain.PixelSize,error)`；RemoteOptions 注入 resolver/dialer 用于离线测试，生产创建安全 transport。

- [ ] **Step 1 — 写失败测试。** 明确断言：auto+900×1200→Exact=`900x1200`；显式 `2K` 不读 URL；`1024x1024`→1K+1:1；`2K` 不给 ratio 时上游无 ratio、expected=2048×2048；输入 mask/stream=true/file_id/partial_images→400；n=11 接受，0/1.5/字符串/超 int64 拒绝。
- [ ] **Step 2 — RED。** `go test ./internal/images -v`；预期未定义 parser/尺寸转换。
- [ ] **Step 3 — 实现尺寸与 JSON/multipart。** 固定 1K 表：1:1 1024×1024、3:4 864×1152、4:3 1152×864、16:9 1312×736、9:16 736×1312、2:3 832×1248、3:2 1248×832、21:9 1568×672；tier 缩放 1/2/3/4。最近档位按 `abs(log(area/tierArea))`、比例按 `abs(log(aspect/ratio))`，并列按表顺序。JSON 严格单对象、无尾随第二对象；multipart 流式累计总字节，20 MiB/16 张/32 MiB 边界，清理临时文件，PNG/JPEG/WebP sniff 与声明校验；image/image[]/images/data URI/{image_url} 归一为字符串数组，不支持 file_id。未显式 size 才读取第一张尺寸，失败 400，不兜底。默认无参考图使用 settings defaultTier。
- [ ] **Step 4 — 实现 Agnes payload。** 始终 `/images/generations`，显式 n=1，不转发客户端 n。reserved extra_body image/ratio/response_format/return_base64/n 不能覆盖解析结果；imageParamMode 只选一种 image 位置，参考图响应格式放 extra_body，纯文生图 base64 用 return_base64=true；模型透传。未知顶层/非生效 OpenAI 字段仅告警，去重。Normalize 要求非空有效图片数组；空字符串→nil、revised_prompt null，不伪造 usage。
- [ ] **Step 5 — 实现安全读取。** resolver→公网地址判断→DialContext 连接同一个已检验 IP，保留原域名 TLS ServerName；禁用环境代理绕过安全 dial。拒绝 credentials/私网/loopback/link-local/CGNAT/保留地址/IPv4 mapped IPv6 私网；每跳重验，限制 2 跳。读头 1 MiB、10 秒，png/jpeg/webp 不需全图解码；Download HTTPS-only、64 MiB、60 秒；未知 MIME 不返回可归档 bytes。测试用假 resolver/dialer 映射公网 fixture，不加生产 allow-private 开关。
- [ ] **Step 6 — GREEN 与检查点。** `go test ./internal/images`；精确上限/多一个字节、17 张、畸形 data URI/WebP/JPEG、200 非图片、重定向到私网、DNS 重绑定、gzip 展开上限、显式尺寸零网络调用、超大 JSON n 不引起浮点损失均覆盖。

### Task 5：Agnes HTTP 客户端、账号池与失败聚合

**Files:** Create `internal/agnes/{client,pool,failures}.go`; Test 对应 `_test.go`。

**Interfaces:** Consumes Store Claim/RecordSuccess/RecordFailure 与 images Payload/Normalize。Produces `agnes.NewClient(httpClient *http.Client)*Client`、`Client.Generate(ctx,baseURL,key string,payload map[string]any,timeout time.Duration)(json.RawMessage,error)`、`agnes.NewPool(accounts AccountRepository,client Generator,now func()time.Time)*Pool`、`Pool.Generate(ctx,req domain.ImageRequest,settings domain.Settings)(agnes.Generation,error)`；Generation 有 Images/AccountID/AccountName/Attempts，失败也返回已完成 Attempts。`SelectFailure([]error,now time.Time)error`。

- [ ] **Step 1 — 写失败测试。** 401 A→429 B→200 C，三次 payload 相同且 Key 分别正确；400 不请求 B；5xx→502、timeout→504；全池不可用→503。HTTP 日期/秒数 Retry-After，负值/畸形默认 60，最大 900；[503,502,504,429]→429，两条 429 选更短。
- [ ] **Step 2 — RED。** `go test ./internal/agnes -v`。
- [ ] **Step 3 — 实现。** 每次排除已试账号，最多 settings.MaxAttempts（1—10）；401/403 900s、429 规范化冷却、其他可重试错误 60×2^failCount 秒封顶 900；成功 Normalize 后计数，畸形 2xx 视作502重试。错误消息限制长度并脱敏；redirect 不得转发 Bearer 到其他 origin，不默认随跳跨域携带 Key。
- [ ] **Step 4 — GREEN 与检查点。** `go test ./internal/agnes ./internal/store`；测试取消时无下一次 claim、池失败包含全部 attempt、成功 CAS、transport 错误不回显 token、Retry-After 时间边界。

### Task 6：日志/用量原子记录与图库存储

**Files:** Create `internal/domain/{logs,gallery}.go`, `internal/store/{logs,usage,gallery}.go`; Test 对应 `_test.go`。

**Interfaces:** Produces `Store.RecordRequest(ctx,log domain.RequestLog)error`（日志+有效 model 的每日用量同一事务）、`RecordEnrichment(ctx,log domain.RequestLog)error`（仅日志，空任务不写）、`ListLogs(ctx,domain.CursorQuery)(domain.Page[domain.RequestLog],error)`、`ClearLogs(ctx)error`、`Overview(ctx,startDay,endDay string)(domain.Overview,error)`、`InsertGallery(ctx,domain.GalleryInsert)(int64,error)`、`ListGallery(ctx,domain.CursorQuery)(domain.Page[domain.GalleryItem],error)`、`GalleryContent(ctx,id,thumbnail bool)([]byte,string,error)`、`GallerySources(ctx,ids []int64)([]domain.GallerySource,error)`、`PendingEnrichment(ctx,before *int64,limit int)([]domain.GallerySource,error)`、`SetEnrichment(ctx,id,domain.EnrichmentWrite)error`、`DeleteGallery(ctx,id)(bool,error)`、`ClearGallery(ctx)error`。

- [ ] **Step 1 — 写失败测试。** requested=5/images=3/failed=2→requests1/successes1/partials1/failures0/images3；全失败→failures1，parse 缺 model 不创建空模型用量。故意让统计 INSERT 失败→日志不留。Gallery BLOB 含空字节往返、列表不含 bytes、tag+cursor 分页无重复、删除同时删 thumbnail/NSFW。
- [ ] **Step 2 — RED。** `go test ./internal/store -run 'Test(Record|Usage|Gallery|Pending|Overview)' -v`。
- [ ] **Step 3 — 实现。** 有效计数从实际结果计算，不相信调用者提供互相矛盾的 ok；记录 requestId/category/stage/attempt JSON，stage parse/dispatch/complete。日期 inclusive UTC，start<=end、范围 1—366 天；Overview 补零且模型总和对应 totals，明确 partials 是 successes 子集。Gallery size 使用 measurement 或 expected，未知原图 MIME/bytes 不入 BLOB、保留 URL；失败状态和删除后的异步 SetEnrichment 为安全 no-op 不复活行。
- [ ] **Step 4 — GREEN 与检查点。** `go test ./internal/store`；并发统计、日期跨 UTC 日界、logs cursor/filter、clear logs 不清 usage、gallery pending 一遍可推进、metadata null 与 SQL NULL 区分、无 BLOB 时 content 404。

### Task 7：Edge-Images 元数据与五分类富化

**Files:** Create `internal/service/{edge,metadata,enrich}.go`; Test 对应 `_test.go`。

**Interfaces:** Consumes Settings、GallerySource/EnrichmentWrite、Store.SetEnrichment。Produces `service.NewEdge(client *http.Client)*Edge`、`Edge.Measure(ctx,outputs []domain.OutputImage,settings domain.Settings)([]domain.Measurement,[]string)`、`Edge.Enrich(ctx,sources []domain.GallerySource,settings domain.Settings)(service.EnrichReport,error)`；EnrichReport Processed/Succeeded/Failed int；TagForNSFW(scores)(string,error)。

- [ ] **Step 1 — 写失败测试。** mock 接受顶层数组 uuid→`{status:"ok",data:{width:864,height:1152,format:"jpg"}}`，输出 measurement 864×1152/jpeg。服务空 URL 不请求且无告警；单项畸形/timeout→measurement nil+size-measure-failed。21 项分两批，不重复 UUID。
- [ ] **Step 2 — RED。** `go test ./internal/service -run 'Test(Edge|Measure|Enrich|Tag)' -v`。
- [ ] **Step 3 — 实现 Measure。** URL 优先，没有 URL 才 base64；params format=json，10s、每批20；位置结果稳定复用，sourceContentType 格式兜底仅 png/jpeg/webp，jpg→jpeg。不同项失败不让成功项测量丢失。
- [ ] **Step 4 — 实现 Enrich。** params width=height=ThumbnailWidth/crop=none/size=down/format=webp/quality/nsfw=1；URL 单项错误且本地 bytes 存在→单次 base64 fallback；classifier 数据缺失是失败，不伪造 safe。scores 0—1 finite，tie safe/drawing/sexy/porn/hentai；合法分类没有合法 thumbnail 仍成功。不存大于等于已知原图的缩略图，校验实际 magic 而不是只信 contentType；URL 不计源字节、base64 按解码长度分批32 MiB，单张>50 MiB直接失败，32—50 MiB内联源记`source exceeds batch budget`，都不发HTTP；包括URL失败后的base64回退，不增加独占批超预算例外。
- [ ] **Step 5 — GREEN 与检查点。** `go test ./internal/service -run 'Test(Edge|Measure|Enrich|Tag)'`；分别测试五类获胜/并列、NaN/缺字段、坏 base64、URL失败回退一次、无本地副本失败、批次网络失败不影响请求结果。

### Task 8：可取消容量、归档生命周期与补齐进度

**Files:** Create `internal/service/{tasks,archive,backfill}.go`; Test 对应 `_test.go`。

**Interfaces:** Consumes Remote.Download、Store.InsertGallery/GallerySources/PendingEnrichment/SetEnrichment、Edge.Enrich。Produces `NewTasks(options TaskOptions)*Tasks`、`Tasks.Reserve(ctx)(*Reservation,error)`、`Reservation.Submit(task func(context.Context))error`、`Reservation.Release()`、`Tasks.StopAdmission()`、`Tasks.Drain(ctx)error`；`NewArchiver(...)*Archiver`、`Archiver.Run(ctx,ArchiveJob)error`（job含请求快照和该客户端请求全部成功图）；`NewBackfill(...)*Backfill`、`Backfill.Start(ctx)(BackfillStatus,error)`、`Backfill.Status()BackfillStatus`、`Backfill.Stop(ctx)error`；`BackfillStatus{Running bool; StartedAt,FinishedAt *time.Time; Processed,Succeeded,Failed int; Error *string}`。

- [ ] **Step 1 — 写失败测试。** capacity=2 占满，第三个 Reserve 在 cancel 后返回 context.Canceled，计数无泄漏；StopAdmission 后新 Reserve 拒绝，而旧 reservation 仍可 Submit；Submit/Release 重复调用返回/忽略明确错误不 panic；Drain 等待阻塞的合法任务完成，不提前 close channel。
- [ ] **Step 2 — RED。** `go test ./internal/service -run 'Test(Tasks|Reservation|Archive|Backfill)' -v`。
- [ ] **Step 3 — 实现容量与退出状态机。** 每客户端请求只Reserve一次，reservation只可转交一次；容量覆盖在途客户端请求+等待归档+正在归档，总数<=32；4个worker。不要每子请求留一份capacity等整个n响应结束，会在n>capacity时死锁。Shutdown：StopAdmission→在途handler结束/取消→归还未用reservation→排空任务→关闭worker；context与服务生命周期绑定，不能绑定客户端已取消context；任务panic捕获为失败并释放。不无限goroutine等待发送，也不在任务结束之前释放容量；任务数有界不代表输出字节内存有界。
- [ ] **Step 4 — 实现归档。** Submit 在响应 body 写完后执行（HTTP Task 10 负责边界），每输出一行；base64合法图存BLOB，URL受控下载失败插未归档行；保留测量/预期尺寸、prompt/账号快照。下载成功写BLOB失败时尝试元数据行和base64富化；两次写库都失败仅脱敏服务日志。归档/富化日志与客户端请求日志独立，未配置服务不写虚假富化任务。
- [ ] **Step 5 — 实现补齐。** 单任务、捕获启动时最大ID，游标从新到旧只遍历该快照；每图与自动富化共享ID互斥锁，重新读取状态避免已完成再做；处理已删除行不复活。状态进度可并发读取；重复 Start→409 `enrichment_running`；图片服务关闭→400 `image_service_disabled`；空遍不写日志。只补thumbnail/NSFW、不Download、不重新Measure；无 URL、无 bytes明确失败。
- [ ] **Step 6 — GREEN 与检查点。** `go test ./internal/service -count=10`；快速delete/clear与归档/富化交叉、启动后新图不延长遍历、失败单遍不重试、client cancel 后已接收归档仍完成、Stop/Reserve/Submit并发压力、Drain超时释放/记录未完成状态覆盖。

## Phase B：认证、业务编排与管理 HTTP

### Task 9：密钥、会话、Origin/CORS 与可信反代

**Files:** Create `internal/auth/{secret,session,limiter}.go`, `internal/store/auth.go`, `internal/httpapi/{middleware,auth}.go`; Test 对应 `_test.go`。

**Interfaces:** Produces `auth.EqualSecret(a,b string)bool`、`auth.NewSessions(key string,state EpochStore,now func()time.Time)*Sessions`、`Sessions.Issue(ctx)(string,error)`、`Verify(ctx,token)(*Claims,error)`、`Renew(ctx,token)(*string,error)`、`Revoke(ctx)error`；`Claims{Epoch int64; IssuedAt,ExpiresAt time.Time}`；`Store.SessionEpoch(ctx)(int64,error)`/`BumpSessionEpoch(ctx)(int64,error)`；`auth.NewLimiter(now)*Limiter`、`Limiter.Allow()bool`/`Failed()`/`Reset()`；`httpapi.NewAuth(options AuthOptions)*Auth`、`Auth.Data(next)http.Handler`/`Auth.Admin(next)http.Handler`/`Auth.SessionHandler()http.Handler`。

- [ ] **Step 1 — 写失败测试。** Cookie不可调用数据面、同Bearer可管理；30d到期拒绝、剩余6d续期、issued+90d不再延长；篡改/epoch变化/换key失效。10次登录失败后第11次429+Retry-After60，成功清零。跨Origin cookie PATCH拒绝；没有Origin的cookie mutation拒绝，Bearer不因缺Origin拒绝；CORS不把任意来源当allowed。
- [ ] **Step 2 — RED。** `go test ./internal/auth ./internal/httpapi -run 'Test(Secret|Session|Login|Origin|CORS|Proxy)' -v`。
- [ ] **Step 3 — 实现。** SHA-256再constant-time比较，HMAC会话签名含version/epoch/iat/exp；JSON token有尺寸上限，签名验证在claims信任前，epoch读缓存只在单进程保证revoke立即生效。Cookie Path=/admin、HttpOnly、SameSite=Lax；Secure按r.TLS或来自可信代理的外部HTTPS，Max-Age取实际剩余；注销只删cookie，revoke bump epoch。login支持paste/password manager，不在前端存key。
- [ ] **Step 4 — 实现可信反代。** `TRUSTED_PROXY_CIDRS` 可选逗号CIDR；默认不信任何forward header。仅RemoteAddr属于白名单时，允许单个合法X-Forwarded-Proto/Host决定外部origin；多值/非法host拒绝或忽略，不接受任意客户端XFF分桶。管理cookie mutation的Origin与推导外部origin完全匹配；数据CORS仅明确allowlist，不跨域cookie。所有管理错误也no-store，安全头覆盖。
- [ ] **Step 5 — GREEN 与检查点。** `go test ./internal/auth ./internal/httpapi`；伪造forwarded、白名单TLS反代、错误token超长、数据库epoch异常、Bearer不续期、HTML不续期、logout/revoke响应语义覆盖。

### Task 10：图片请求编排与标准 API

**Files:** Create `internal/service/images.go`, `internal/httpapi/{images,router}.go`; Test `internal/service/images_test.go`, `internal/httpapi/images_test.go`。

**Interfaces:** Consumes Parse/Pool/Tasks/Edge.Measure/Archiver/RecordRequest/Auth。Produces `service.NewImages(options ImageOptions)*Images`、`Images.Generate(ctx,req domain.ImageRequest,settings domain.Settings,requestID string)(*ImageResult,error)`；`ImageResult{Response ImageResponse; Headers http.Header; Log domain.RequestLog; CommitArchive func()error; CancelArchive func()}`（两方法只允许一个成功，Commit在handler写响应后转交全部预留任务；记录由service管理并受服务context超时保护）；`httpapi.New(options Options)http.Handler`（Task11扩展管理依赖），`ImageResponse{Created int64; Data []ImageResponseItem; Size string; OutputFormat *string}`。

- [ ] **Step 1 — 写失败测试。** n=5、完成顺序乱、三个成功→200/data按子请求顺序/Requested5/Succeeded3/Failed2/Warnings partial-success；全部失败选Task5优先级。元数据864×1152同时出现response/log/gallery快照，无第二次Measure。未鉴权401有requestId但无库记录；parse400有parse日志。单数路径404。
- [ ] **Step 2 — RED。** `go test ./internal/service ./internal/httpapi -run 'Test(Image|Generation|Partial|Cancellation)' -v`。
- [ ] **Step 3 — 实现调度。** 每请求Parse成功后Reserve一次后台任务容量，全失败Release，有成功图转交一个ArchiveJob。每请求最多8个worker按int64索引拉取子请求，另有服务级共享semaphore保证所有请求总上游在途<=8；每次取semaphore支持ctx取消，不把客户端n改成8。禁止创建N个goroutine或按N预分配巨大切片。输出/attempt内存随实际执行结果增长，不假称无限N零内存。取消后停止未发起工作；已有成功项即使HTTP写失败也commit归档，没有成功则release。结果汇总后同一批Measure，未配置不告警，实测失败log null/响应expected，revised_prompt null。
- [ ] **Step 4 — 实现HTTP。** 用MaxBytesReader总32MiB与content type校验；鉴权先于body解析。日志request/parse/dispatch/complete一致；model目录无requestId，health/deep数据库错误不泄漏信息；错误保留Retry-After与OpenAI信封。服务记录日志/用量使用独立15s budget，不使用已取消request context；失败不改写成功响应。
- [ ] **Step 5 — GREEN 与检查点。** `go test ./internal/service ./internal/httpapi`；n=1000慢archive时观察上游在途<=8、容量<=32、cancel无泄漏；成功后HTTP写错误仍归档；shutdown交叉无额外claim；每成功上游返回多图时ArchiveJob归档所有图；200空图走failover。

### Task 11：管理 API、DTO 契约、探测与内容安全

**Files:** Create `internal/httpapi/{accounts,settings,logs,overview,gallery}.go`, `internal/service/probe.go`, `docs/api/admin.openapi.yaml`, `internal/httpapi/testdata/admin-contracts.json`; Extend router/auth；Test 对应 `_test.go`。

**Interfaces:** Consumes Store/Backfill/Pool/Sessions。Produces 以下唯一管理契约，TS对应Task2 `contracts.ts`，统一错误采用apierror信封：

| Route | Request / response |
|---|---|
| `POST /admin/api/session` | `{apiKey:string}` → `{authenticated:true}` + Cookie |
| `GET /admin/api/session` | `{authenticated:true}`；失效401，不返回token |
| `DELETE /admin/api/session` | 204 + clear Cookie |
| `POST /admin/api/session/revoke` | 204 + clear Cookie、epoch bump |
| `GET /admin/api/accounts` | `{items:AccountSummary[]}` |
| `POST /admin/api/accounts` | `{name,apiKey}` →201 AccountSummary |
| `PATCH/DELETE /admin/api/accounts/{id}` | patch name/apiKey/enabled →summary /204 |
| `POST /admin/api/accounts/import` | `{accounts:[{name,apiKey}]}` →`{imported:number,errors:[{index,message}]}`；逐行错误可报告，不二次自动提交成功行 |
| `POST /admin/api/accounts/{id}/test` | `{id,ok,status,message}`；不返回key |
| `POST /admin/api/accounts/test` | `{items:ProbeResult[]}`；并发由ProbeConcurrency限制 |
| `POST /admin/api/accounts/{id}/reset` | 204；不存在404 |
| `GET/PUT /admin/api/settings` | Settings；PUT完整已验证新结构，未知字段400 |
| `GET/DELETE /admin/api/logs` | before/limit/category →Page<RequestLog> /204 |
| `GET /admin/api/overview` | start/end UTC日期 →Overview，默认最近7天 |
| `GET/DELETE /admin/api/gallery` | before/limit/tag →Page<GalleryItem> /204 |
| `DELETE /admin/api/gallery/{id}` | 204，不存在404 |
| `GET /admin/api/gallery/{id}/content` | 原图bytes或404；`?download=1` attachment |
| `GET /admin/api/gallery/{id}/thumbnail` | 缩略图bytes或404，不以原图冒充成功缩略图 |
| `POST/GET /admin/api/gallery/enrich` | Start →202 BackfillStatus；status →BackfillStatus |

`service.NewProbe(...)*Probe`、`Probe.One(ctx,id,settings)(ProbeResult,error)`、`Probe.All(ctx,settings)([]ProbeResult,error)`；探测走 `/models` 或已证实不会消耗图像额度的模型可用性请求，不用Generate生成图片。

- [ ] **Step 1 — 写失败测试。** 每条route测试方法/鉴权/DTO/状态码；session GET无token、account CRUD/import/probe无完整key；未知字段/非法ID/tag/date返回400；未知API404 JSON、非GET页面不返回SPA。
- [ ] **Step 2 — RED。** `go test ./internal/httpapi -run 'Test(Admin|Account|Setting|Gallery|Overview|Contract)' -v`。
- [ ] **Step 3 — 实现窄handler。** body解析限制管理JSON1MiB、import<=1000行；交给Store/Probe/Backfill，不在handler创建后台goroutine；输出与OpenAPI fixture一致。probe不更新客户端usage/gallery，不伪造成功上游image调用计数；失败仍可更新账号健康。
- [ ] **Step 4 — 实现内容响应。** 只PNG/JPEG/WebP，nosniff、sandbox CSP、safe Content-Disposition，Etag/缓存不泄漏权限；管理响应均no-store（浏览器Query可内存缓存blob以避免重复下载）。不直接redirect客户端到未经控制sourceURL；未归档记录通过元数据显示可复制源链接，外链显式noopener/noreferrer。
- [ ] **Step 5 — GREEN 与检查点。** `go test ./internal/httpapi ./internal/service`；契约fixture供frontend运行时Zod校验，epochrevoke/admincookies安全头、内容非图片404/下载文件名、探测并发和取消覆盖。

## Phase C：React 业务页面

### Task 12：类型化数据层、登录、账号、设置与日志

**Files:** Create `frontend/src/features/{auth,accounts,settings,logs}/*`, `frontend/src/lib/{schemas.ts,errors.ts}`, `frontend/src/components/{data-state.tsx,confirm-action.tsx,status-badge.tsx}`, `frontend/src/test/{handlers.ts,server.ts}`, `frontend/src/features/*/*.test.tsx`; Extend api/query keys/router/contracts。

**Interfaces:** Consumes Task11唯一DTO。Produces `LoginPage`, `AccountsPage`, `SettingsPage`, `LogsPage`；hooks `useSession`、`useAccounts`、`useSettings`、`useLogs(params)`、mutations针对对应endpoint；`ApiError` 包含status/message/param/code，providers统一on401清理缓存并replace登录。

- [ ] **Step 1 — 写失败测试。** MSW模拟登录成功Cookie后导航overview；401清query并跳login，不保存key；AccountPatch空key不会发旧key；PUT失败保留输入且定位字段；导入部分失败不再次导入成功行；logs category URL变化只显示对应数据。fixture `admin-contracts.json` 经过schemas全部成功，缺字段或错误类型失败。
- [ ] **Step 2 — RED。** `npm --prefix frontend run test -- --run src/features/auth src/features/accounts src/features/settings src/features/logs`。
- [ ] **Step 3 — 实现api/query生命周期。** fetch credentials=same-origin、signal；401用集中清理，不反复redirect；mutation默认retry=false，query网络错误最多1次且401/400不重试；hidden暂停轮询，刷新显示background状态。React局部状态不重复存服务端数据；筛选search params驱动query key。
- [ ] **Step 4 — 实现页面。** shadcn Field/Label、字段错误与多错error summary；Account列表脱敏，CRUD/启停/测试/批量测试/reset/import按钮pending，导入说明同账号key不叠加；Settings分组与URL固定说明，不创建defaultResponseFormat控件；revoke确认并重新登录。Logs request/enrich切换、游标、详情Dialog、clear AlertDialog，小屏摘要卡，文字/图标状态。
- [ ] **Step 5 — GREEN 与检查点。** `npm --prefix frontend run typecheck && npm --prefix frontend run lint && npm --prefix frontend run test -- --run`；键盘/label/重复提交/失败重试/401旧数据清理/hidden不轮询测试覆盖，组件不包含dangerouslySetInnerHTML渲染上游日志。

### Task 13：图库、原图弹窗、竞态处理与富化任务反馈

**Files:** Create `frontend/src/features/gallery/{page.tsx,queries.ts,cards.tsx,image-dialog.tsx,backfill-status.tsx,gallery.test.tsx,image-dialog.test.tsx}`, `frontend/src/lib/blob-cache.ts`; Extend MSW。

**Interfaces:** Consumes GalleryItem/Page/BackfillStatus、api/query keys。Produces `GalleryPage`、`ImageDialog({item,onClose})`；`useGallery(params)`、`useBackfillStatus()`；`BlobCache` 按gallery ID/类型键缓存，容量16项、最多64MiB，总字节超出不缓存，eviction/clear调用URL.revokeObjectURL；logout/query清理调用cache.clear。

- [ ] **Step 1 — 写失败测试。** 图片A请求延迟、切到B先成功、A迟到→Dialog仍只显示B；关闭A再开B不出现A。分类切换旧page迟到不混入；thumbnail404仅fallback原图一次，原图失败显示错误不循环。backfill running刷新后恢复计数并disabled，完成invalidate gallery、空任务不toast虚假成功。
- [ ] **Step 2 — RED。** `npm --prefix frontend run test -- --run src/features/gallery`。
- [ ] **Step 3 — 实现列表/弹窗。** useInfiniteQuery游标加载更多、24项默认、UTC日期分组、英文tag中文label；img固定aspect ratio/尺寸占位+loading=lazy，caption可访问。Dialog key跟随ID、image ready状态按ID关联、AbortSignal与object URL缓存，load/error必须校验当前ID；Radix负责focus/Escape/返回焦点，不自写trap。原图download使用content?download=1同源；blob网络错误有重试，未归档展示明确状态和source链接复制。
- [ ] **Step 4 — 实现任务/删除。** POST enrich后GET轮询，hidden暂停且回页重取；运行中禁重复点击，不以客户端布尔值替代服务器状态；polite区域仅状态转变/有意义进度朗读。delete/clear前AlertDialog，pending按钮disabled，成功invalidate并释放已删除cache；清空不误清logs/usage。
- [ ] **Step 5 — GREEN 与检查点。** `npm --prefix frontend run test -- --run src/features/gallery && npm --prefix frontend run typecheck`；test监控create/revokeObjectURL平衡、16项/64MiB eviction、快速切换、页面离开、401 logout、同缩略图失败不重复请求；375px无整页overflow。

### Task 14：总览、真实计数与可访问趋势图

**Files:** Create `frontend/src/features/overview/{page.tsx,queries.ts,usage-chart.tsx,overview.test.tsx,usage-chart.test.tsx}`, `frontend/src/components/stat-tile.tsx`, `frontend/scripts/check-colors.mjs`; Extend MASTER主题记录。

**Interfaces:** Consumes Overview/UsageTotals/DailyUsage/ModelUsage。Produces `OverviewPage`、`UsageChart({days,metric:'requests'|'images'})`；useOverview({start,end})，日期参数随URL；空数组与零值是不同正常态，不除零。

- [ ] **Step 1 — 写失败测试。** totals请求5/成功3/partials2/失败2→展示成功3不是5；缺日期补0，UTC排序；model行和total对得上。折线请求和图片各自单轴、表格提供相同逐日数值；键盘选中日期显示tooltip，无数据提示；filter change保持日期query key一致。
- [ ] **Step 2 — RED。** `npm --prefix frontend run test -- --run src/features/overview`。
- [ ] **Step 3 — 实现统计。** 五个headline数字卡、UTC日期范围、模型表、账号健康摘要；单系列requests折线+独立images折线，不双轴、饼图或装饰仪表。Recharts以主题token读取颜色，2px线、可点击/键盘目标>=44px、recessive网格；小屏图表不挤压数字卡。表格视图与tooltip用中性文字色、语义标题。
- [ ] **Step 4 — 验证可视化。** 实施前加载dataviz form/marks/interaction/anti-patterns与palette reference；运行其validate_palette.js对浅/深主题选用系列色+实际surface校验，PASS方可登记MASTER；WARN必须提供标签/表格，FAIL改色后再验。多系列不在本期制造，单系列不强加空图例。
- [ ] **Step 5 — GREEN 与检查点。** `npm --prefix frontend run test -- --run src/features/overview && npm --prefix frontend run typecheck && npm --prefix frontend run build`；Playwright后续验证图形实渲染、tooltip位置、长模型名overflow、reduced-motion禁动画。

## Phase D：组装、实测与交付

### Task 15：应用命令、离线 preview 与生命周期组装

**Files:** Create `cmd/agnes-proxy/{main,commands}.go`, `internal/preview/preview.go`, `internal/service/runtime.go`; Test `cmd/agnes-proxy/commands_test.go`, `internal/preview/preview_test.go`, `internal/service/runtime_test.go`。

**Interfaces:** Produces `Run(ctx context.Context,args []string,getenv func(string)string,stdout,stderr io.Writer)error`；默认serve、`preview --port 8001`、`healthcheck --url http://127.0.0.1:8000/health`、`reset-db --confirm`。`service.NewRuntime(options RuntimeOptions)(*Runtime,error)`、`Runtime.Handler()http.Handler`、`Runtime.Shutdown(ctx)error`；preview与serve共用同一router/store/service，只依赖配置不同。

- [ ] **Step 1 — 写失败测试。** preview不提供生产env也可health/admin/mock generate/edits，固定模拟key=`preview`；serve缺env失败且不会回退preview。reset无confirm在打开远程连接前失败；healthcheck非2xx/timeout返回非零。shutdown先stop新request/reserve，再完成已提交归档，最后db.Close。
- [ ] **Step 2 — RED。** 前端build后 `go test ./cmd/agnes-proxy ./internal/preview ./internal/service -run 'Test(Run|Preview|Runtime|Shutdown)' -v`。
- [ ] **Step 3 — 实现组装。** serve初始化new schema/store→session/pool→task/edge/archive/backfill→HTTP；preview使用temp SQLite和本机httptest样式模拟server，含png/jpeg/webp、NSFW五类、错误/冷却/partial/log示例，不混入真实key。DB.Close、server transport、模拟server均由Runtime持有关闭，测试检查无泄漏。
- [ ] **Step 4 — 实现退出。** signal.NotifyContext，默认120s统一budget；Server.ReadHeaderTimeout=10s，不用短WriteTimeout截断300s生成，Body与upstream各有独立限制；shutdown停止admission但等在途reserver完成，预算耗尽cancel并记录未完成数量，不声称强杀不丢任务。不要先关任务channel再等待handler。
- [ ] **Step 5 — GREEN 与检查点。** `go test ./... && go vet ./...`；本地 `go run ./cmd/agnes-proxy preview --port 8001` 后用HTTP检查health/login/models/JSON+multipart/图库，均离线。输出key仅preview明确提示，不打印生产secret。

### Task 16：Docker、浏览器验收与删除旧实现

**Files:** Create `Dockerfile`, `compose.yaml`, `.env.example`, `.dockerignore`, `frontend/{playwright.config.ts,e2e/console.spec.ts,e2e/gallery.spec.ts,e2e/accessibility.spec.ts}`；Modify `.gitignore`, `README.md`；Delete旧 `main.ts`, `lib/`, `web/`, `scripts/`, `tests/`, `deno.json`, `deno.lock`，旧 `docs/superpowers/plans/2026-11-20-agnes-image-proxy.md`、`docs/superpowers/specs/2026-11-20-agnes-image-proxy-design.md`、`docs/superpowers/specs/2026-11-21-agnes-auto-size-design.md`（执行前Read确认内容，只有新契约测试覆盖后移除）。

**Interfaces:** Consumes完整Runtime/React产物；Produces单Go容器、可复现实测命令和最终验证报告。Compose只含agnes-proxy，无Node/SQLite生产sidecar或volume。

- [ ] **Step 1 — 写失败E2E。** Playwright启动production-build的Go preview（不是Vite devserver），登录/浏览五页面/修改设置/CRUD账号/分类/日志/模拟生成/补齐状态/下载/delete-confirm/注销均验证真实HTTP。深链接refresh、原图A→B乱序、mobile Sheet焦点、取消AlertDialog零删除、401后重新登录无旧缓存、hidden不轮询均有断言。
- [ ] **Step 2 — RED。** `npm --prefix frontend run test:e2e`；预期未实现E2E配置或行为失败；如browser缺失先报告并在获准后安装测试浏览器，不把缺浏览器当行为RED。
- [ ] **Step 3 — 实现Docker。** Node24多阶段npm ci/build→Go1.26 builder复制dist→`CGO_ENABLED=0`编译Linux→固定版本非root含CA的distroless/static等运行镜像，只复制binary；健康检查调用binary healthcheck，无curl依赖。Compose port8000、restart unless-stopped、stop_grace_period=120s、requiredenv、可信反代/资源参数可选，environment只引用.env不内嵌秘密。不得在Docker context包含.codegraph/.git/.env/test-key.txt/cache/node_modules/旧Deno产物。
- [ ] **Step 4 — 更新文档与删除。** README包含Node/Go开发顺序、Vite代理/admin同源、npm ci/build→Go run、Docker compose、Turso空库与reset破坏性说明、API/后台任务上限/优雅退出/强杀边界、Edge-Images allowlist域名配置、preview离线、无迁移；env展示PORT8000与三必需变量，资源默认8/4/32/120s、TRUSTED_PROXY_CIDRS未配置不信forwarded。清理旧源码与文档，不保留old命令/别名/默认格式转换；.codegraph目录是用户未跟踪数据，不删除/提交。
- [ ] **Step 5 — 全面验收。** `npm --prefix frontend ci && npm --prefix frontend run typecheck && npm --prefix frontend run lint && npm --prefix frontend run test -- --run && npm --prefix frontend run build`；`go test ./... && go vet ./...`；检查gofmt -l无文件；支持CGO/race时 `go test -race ./...`。`GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o .build/agnes-proxy ./cmd/agnes-proxy` 验证无CGO；必要时arm64同样验证。
- [ ] **Step 6 — UI实渲染验收。** `npm --prefix frontend run test:e2e`，axe无serious/critical问题；保存375/768/1024/1440各light/dark截图并人工看布局、长文本、focus、tooltip/弹窗、整页overflow；测试200%浏览器zoom与reduced-motion；不得只用axe宣称完整可访问性合格。
- [ ] **Step 7 — Docker验证与最终检查点。** 如果Docker可用：`docker compose config --quiet`→`docker build -t agnes-image-proxy:local .`→容器运行binary preview验证health/admin并检查非root→容器SIGTERM验证退出；不默认用.env连接生产Turso验证。当前Docker未安装，仍不可用时明确标注镜像构建/运行未验证，只报告交叉编译/静态配置检查结果。运行verification-before-completion与requesting-code-review技能，对完整新实现做一次独立审阅；修复后重跑受影响测试，无用户要求不commit/push/deploy。

## 自检与实施时的约束裁决

- 本计划各阶段依赖同一组domain/Store签名，HTTP和前端只通过Task11DTO交互；不额外创建同名行为不同的factory或兼容adapter。
- Phase A对应spec§2—9，Phase B对应spec§4/5/8，Phase C对应spec§11，Phase D对应spec§10/12/13；五项Review Focus均有具体测试任务。
- 单项内联源32—50MiB不能组成32MiB合法批，记batch budget错误；>50MiB记source size错误。该规则已同步spec，URL不计预算，URL→base64重试仍要重新分批。
- 归档容量按客户端请求预留，上游并发全局限8；n>32不会卡在子请求未释放容量。输出字节总量仍未设置硬预算，README必须披露内存边界。
- 先构建React才能编译embed服务是有意契约；Task1数据库测试不依赖未创建的embed包，Task2首次生成dist后后续全仓Go测试可运行。不提交占位index或编译期空白fallback。
- Settings与DTO只存在一套，PUT完整结构、camelCase与MS时长不变；固定URL格式只在文档说明，不重引入可变defaultResponseFormat。
- 生产HTTP驱动能力必须Task1先验证；不能用SQLite通过来假装真实Turso已验证。真实联网验证缺授权时列入未验证项，继续离线行为测试而不杜撰结果。
- 一项完成只代表其测试通过；Docker/真实Turso/真实Agnes/浏览器/race均单独报告，不把未运行测试标成通过。

## 执行交接

计划编写不授权实施、删除旧源码或提交代码。用户审阅此计划后选择：

1. **Native（推荐）**：本会话逐项实施、每项TDD与检查点，最后一次独立整体验证。16项任务共享紧密Store/domain/HTTP契约，连续上下文可减少交接损失和重复阅读。
2. **Subagent-driven**：每项新implementer与reviewer，最后整体审阅；独立关卡更多，但上下文与审阅成本更高。

两者均执行同一验收、不自动提交或部署；开始时再创建隔离工作区，按用户选定方式执行。
