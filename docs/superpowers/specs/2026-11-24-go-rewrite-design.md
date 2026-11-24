# Go 后端与 React 控制台全量重构设计

日期：2026-11-24
状态：功能范围与技术栈已确认；本版作为实施计划依据

## 1. 目标与已经确认的约束

将 Agnes Image Proxy 从 Deno/TypeScript 完整重写为 Go 服务，最终通过 Docker 部署。

用户确认：

- 保留 OpenAI Images 接口、账号池、管理控制台、图库、日志与用量统计。
- 保留 Agnes、Edge-Images 元数据/缩略图、nsfw-detection-2-mini 集成。
- 继续使用远程 Turso 数据库，图片和缩略图仍保存为数据库 BLOB。
- 不兼容旧程序、旧数据库或旧设置；不实现迁移、双写、旧字段转换、旧实现回退。
- 页面采用框架与成熟组件库，并按 ui-ux-pro-max 标准实施；采用 Go 后端 + React/TypeScript + Vite + Tailwind CSS + shadcn/ui + TanStack Query，单 Docker 服务部署。

成功标准：后端业务与生产运行服务完全使用 Go；浏览器前端使用 React/TypeScript。开发与构建需要 Go 及 Node/npm，Docker 最终运行镜像中无需 Deno、Node 或前端构建工具。现有产品能力有离线测试覆盖，文档和部署入口均指向新实现。

## 2. 推荐技术方案（实现者的选择）

- Go 1.26，标准库 `net/http`、`encoding/json`、`context`、`crypto`、`embed`。
- 使用标准库路由，不引入重型 Web 框架、ORM、Redis 或消息队列。
- 通过维护中的 Go libSQL HTTP 驱动连接远程 Turso，并使用 `database/sql`；生产路径不引入本地副本、同步或数据库文件。
- 测试使用本地 SQLite 执行相同 SQL；如果生产驱动不能离线使用 SQLite，增加仅供测试的纯 Go SQLite 驱动，不实现第二套存储业务逻辑。
- 管理页使用 React + TypeScript + Vite；Tailwind CSS + shadcn/ui 负责样式与可访问组件，TanStack Query 负责服务端数据缓存、失效和刷新，React Router 负责深链接。shadcn/ui 使用 Radix 基础组件，不自写焦点陷阱或重造 Dialog/Select 等基础交互。
- 前端是静态 SPA，不引入 Next.js、SSR、独立 Node 服务或第二个生产容器。Go `embed` 打包构建产物并同源提供 `/admin` 页面、静态资源及管理 API。
- React 组件管理局部 UI 状态；服务端数据不重复放入全局 store。表单以 shadcn/ui Field 和 Zod 校验为基础，复杂表单需要时才引入额外表单库。
- 单进程部署为本期目标。数据原子更新仍放在数据库，避免将账号池正确性建立在内存锁上；不新增分布式任务调度能力。

实施前对驱动做最小验证：远程 URL/authToken 配置、超时取消、BLOB、事务和 `UPDATE ... RETURNING`。具体模块版本由实现者锁定在 go.mod/go.sum。

## 3. 代码组织

建议结构：

```text
cmd/agnes-proxy/       主程序与命令入口
internal/config/      环境变量与启动校验
internal/store/       schema、Turso 访问、账号/设置/日志/用量/图库/会话持久化
internal/agnes/       上游 HTTP 客户端、账号池、失败分类
internal/images/      请求解析、尺寸、响应归一化、受控图片读取
internal/service/     请求编排、归档、Edge-Images 与后台任务
internal/auth/        密钥校验、会话、登录限速
internal/httpapi/     API 路由、中间件、SPA 与静态资源处理
internal/webassets/   Go embed 包与 frontend/dist 构建产物
frontend/             React/Vite 前端项目、package.json 与 lockfile
frontend/src/app/     路由、QueryClient、主题与应用框架
frontend/src/components/  shadcn/ui 与业务共享组件
frontend/src/features/    总览、图库、账号、日志、设置、登录
frontend/src/lib/     类型化 API 客户端、DTO、格式化与 query keys
Dockerfile
compose.yaml
.env.example
README.md
```

这是职责边界，不要求每个名词都建接口或包。只有网络、存储、时间等确需替换的边界使用窄接口；共享 DTO 保持直接、类型明确。避免机械翻译 TypeScript 的闭包和工厂。

## 4. 对外接口与图片请求

保留 OpenAI Images 协议是产品目标，不等于兼容旧内部实现。

- `POST /v1/images/generations`：JSON 文生图，也支持参考图片。
- `POST /v1/images/edits`：JSON 与 multipart 图生图、多参考图。
- `GET /v1/models`：现有静态 Agnes 模型目录；未知模型仍原样透传。
- `GET /health`：存活；`GET /health?deep=1`：数据库就绪检查。
- `/` 跳转 `/admin`，保留管理页及管理 API 的业务能力。
- 不保留单数 `/v1/images/edit` 别名；管理 API 可以采用一套新 DTO，不维护旧 DTO 适配层。上述两个 Images 主端点仍供官方 OpenAI SDK 使用。

请求与响应规则：

- 数据面只接受 Bearer API Key；Cookie 不能调用图片 API。
- 默认返回 `url`；显式 `response_format=b64_json` 或 `return_base64=true` 可请求 base64。
- 模型名不映射。参考图仍支持 URL、data URI、multipart 与 `{image_url}` 数组；限制 16 张、单张 20 MiB、总请求体 32 MiB。
- 支持 `1K`—`4K`、`WxH`、`ratio` 和自动参考图尺寸。未传/空/auto 且有参考图时读取第一张真实尺寸；不可读返回 400。显式尺寸不读取参考图。
- 原生档位/比例表和现有最近面积、比例算法保留；自动读取参考图时发精确 `WxH`，不将 `auto` 发给 Agnes。
- 上游单次 `n=1`；客户端 `n` 保持正整数、不新增任意最大值。通过 goroutine 调度有限数量的在途调用，避免一次创建无限数量 goroutine；并发上限是执行资源限制，不是协议中的 n 上限。
- 每个子请求最多尝试设置指定的不同账号。按原索引汇总结果，部分成功返回 200，仅包含成功图，保留请求数/成功数/失败数/告警响应头。
- 全失败按 `429 > 504 > 502 > 503` 聚合最终错误；同级 429 选较短、封顶 900 秒的 Retry-After。
- 保留 OpenAI 错误信封、请求 ID、X-Agnes 尺寸/警告/部分成功信息。
- OpenAI 非生效可选字段仍以告警形式处理，明确不支持 mask、stream、partial_images、file_id。不新增对旧项目专用字段的兼容。
- 保留上游所需的 `imageParamMode` 配置，只发送所选的一种位置，不在失败后切换请求形状重发。
- 输出空字符串归一化为 null，不伪造 usage，revised_prompt 为 null。

## 5. 账号池与可观测性

- 账号新增、编辑、禁用/启用、删除、批量导入、单个/批量探测、解除冷却。
- 用数据库原子 claim 保证账号选择与计数更新；不同 HTTP 请求共享同一个账号池。
- 401/403 冷却 15 分钟；429 使用 Retry-After 或 60 秒；传输错误、5xx、超时采用 60 秒起指数退避，最长 15 分钟；400/404 不更换账号。
- 成功回写用失败计数 CAS，不能覆盖并发失败刚设置的冷却；上游成功调用数/图片数与客户端请求统计分开。
- 默认上游超时 300 秒，可配置 60—360 秒；客户端取消传播到在途上游请求，不继续尝试新账号。
- 日志记录请求阶段、尺寸表达式、实测尺寸、逐账号尝试、失败分类与请求 ID；解析失败也记录，未鉴权请求不入库。
- request/enrich 两类日志，自动归档富化与手动补齐写独立 enrich 日志。
- 用量满足 requests = successes + failures；部分成功同时属于 successes 和 partials。请求成功/失败/部分成功状态与实际返回图片数一致。
- 对关键日志/统计采用一次事务写入；记录失败不改写已经生成的客户端结果，而在服务日志中明确报告。退出时等待已接收的记录/归档任务。
- 时间与日期持久化统一 UTC；日志、用量与图库列表提供分页、筛选、汇总。

## 6. 图库、元数据与富化

- 返回客户端前，配置图片服务时调用 Edge-Images `/api/batch`，顶层数组、每批最多 20 项、`params={format:"json"}`，读取实际 width/height/format，超时 10 秒。
- 同一份测量结果复用于响应、日志和归档，不重复测量。不配置服务时使用预期尺寸且不告警；测量失败使用预期尺寸并告警，日志实际尺寸为 null。
- 每张成功图归档一行；base64 解码后存 BLOB，URL 在响应后受控下载再存。上限 64 MiB、60 秒。
- 下载失败保留 source_url 与未归档状态，不影响客户端结果；不保存未知类型字节，不入库参考输入图。
- 图库有分页、日期分组、NSFW tag 筛选、缩略图、原图弹窗、下载、单张删除、清空全部。删除/清空有用户确认，不设自动保留上限。
- 图片服务基址为空表示关闭；缩略图宽度默认 640、质量 75、富化超时 60 秒，保留现有合理范围校验。
- 富化请求优先 URL；单项 URL 失败且有本地原图时，仅重试一次 base64。每批最多 20 项，base64 源字节预算 32 MiB，单张 base64 超过 50 MiB 不发送；URL 不计入字节预算。单项内联源超过 32 MiB 已不能组成合法批次，记录 `source exceeds batch budget`；超过 50 MiB 时记录更具体的 `source exceeds 50 MiB`。URL→base64 回退同样受预算约束，不因独占批次绕过 32 MiB 上限。
- 缩略图请求使用 width/height、crop=none、size=down、format=webp、quality、nsfw=1。
- 只接受五分类分数 drawing/hentai/safe/porn/sexy 及 isNsfw；最高分生成 tag，并列按 safe/drawing/sexy/porn/hentai。
- 缩略图类型需校验；有已知原图体积时，仅保存比原图小的缩略图。NSFW 分类成功不以缩略图有效为前提。
- 手动补齐一次从新到旧遍历富化状态为待处理或失败的记录，以游标保证单遍不重复；与自动任务对同一图片互斥，点击时后台处理并提供进度，未配置服务明确报错。
- “补齐”仅处理缩略图与 NSFW 富化，不重新下载缺失的原图 BLOB，不单独重测输出尺寸。未归档但保留 URL 的记录可通过 URL 富化；URL 失效且无本地原图时保持失败。此范围沿用现有产品行为。

## 7. Go 后台任务生命周期

不复刻 Deno waitUntil，也不采用无人管理的裸 goroutine。

- 服务持有 worker 与 context/WaitGroup；前台请求成功后将归档任务交给服务生命周期，客户端断开不取消已接受的归档。
- 设置固定 worker 数量、队列容量与背压，避免 n 和大图片使后台任务无限增长。实施默认：上游全局在途 8、归档 worker 4、请求级任务容量 32、优雅退出 120 秒；资源参数可配置正整数，任务容量不得小于 worker 数，文档明确这是实现资源限制而非 n 上限。
- 归档队列不能因为满载而静默跳过成功图片。每个客户端请求在发起任何上游调用前，等待预留一份请求级后台任务容量；全部失败时释放，有成功图时将该请求全部输出交给一个归档任务，任务结束后释放。排队支持客户端取消；停止服务后不再接收未获容量的新请求，已获容量的在途请求在优雅退出预算内仍可提交归档。上游在途调用另用全局 semaphore 限制；不能按每个子请求占住容量直到整个 n 响应结束，否则 n 大于容量会死锁。此背压策略为实现者的选择。
- 队列容量限制的是请求任务数，不是输出字节数；仍不新增输出体积或 n 上限，巨大 base64 响应仍可能耗尽内存，不宣称队列使内存严格有界。
- 数据库不可用等实际归档失败仍按 §6 保存失败信息或报告服务日志；容量预留不等于持久化成功，不能保证强杀或数据库故障不丢图。
- 归档成功后调用富化，失败保存状态并写服务日志；不增加自动无限重试。
- 手动补齐同一时间只运行一个任务，管理 API 可查询运行状态、已处理/成功/失败数量，页面禁用重复点击。
- SIGTERM/SIGINT：停止接收请求，关闭任务入口，限时等待在途请求和已接受任务，再关闭数据库。Docker stop_grace_period 与默认优雅退出预算一致。
- 正常退出会尽力排空；进程强杀/容器崩溃仍可能丢失内存中的未归档任务。本期不新增持久化任务队列，也不声称具备强杀不丢任务能力。

## 8. 认证与安全

- PROXY_API_KEY 同时作为客户端密钥和管理页登录凭据，SHA-256 后恒定时间比较；日志和管理列表不暴露完整上游 Key。
- 重新实现签名会话：30 天有效，剩余不足 7 天的管理 API Cookie 请求续期，总寿命最长 90 天；Bearer 与 HTML 不触发续期。
- Cookie HttpOnly、SameSite=Lax，HTTPS 场景 Secure；`TRUSTED_PROXY_CIDRS` 可选配置可信反代网段，默认不信任任何转发头。仅来自可信 RemoteAddr 的合法单值 X-Forwarded-Proto/Host 可用于推导外部 origin 与 Secure，拒绝伪造/歧义值。
- 会话 epoch 持久化；撤销全部会话即时在本进程生效。轮换主密钥会使旧会话无效。注销只清当前 Cookie。
- 保留登录失败限速与 CORS 白名单；Cookie 的变更请求检查 Origin，阻止跨站提交。
- 管理响应 no-store，HTML CSP、禁止 framing、nosniff、no-referrer；图库内容只返回 PNG/JPEG/WebP，带 sandbox CSP。
- 图片 URL 拒绝凭据、私网、回环、链路本地、保留/非公网地址；重定向逐跳检查。利用 Go DialContext 检查并绑定实际连接的解析地址，防止校验后重解析导致 DNS rebinding。
- 参考图头读取允许 HTTP/HTTPS、最多 1 MiB、10 秒、2 次重定向；输出归档只允许 HTTPS。测试可注入受控 transport，不削弱生产校验。
- Agnes/Edge-Images 管理员配置基址允许 HTTPS，HTTP 仅允许 localhost 测试用途；不自行访问客户端传入的任意 URL，除受控读头与归档路径。
- 数据库超时 15 秒；连接/超时映射通用 503；deep health 不回显连接细节。所有 SQL 参数绑定，不把密钥、BLOB 或完整敏感数据库错误输出到响应/日志。

## 9. 数据库新契约

- 为 Go 版本定义独立 schema 标识和明确版本，仅负责空库初始化与相同版本启动校验。
- 非空、不匹配或旧版数据库启动时拒绝使用并给出通用重建说明；不得自动删除、迁移、改表或读取旧数据。用户需自行准备新的空 Turso 数据库或明确重建。
- 提供显式 `reset-db` 命令，必须有确认标志；保留破坏性提示，不在本次实施中连接/重置用户真实数据库。
- 账号、设置、会话 epoch、日志、每日模型用量、图库建立新的类型化表与必要索引；状态枚举、分页索引与外键按新代码设计。
- 不保留旧 schema 版本分支；设置只存在一套新结构，默认响应格式固定 URL 不需要可编辑的冗余设置字段。

## 10. Docker、开发与交付

- 多阶段 Dockerfile：Node builder 使用 npm ci 与 Vite 构建前端；Go builder 嵌入产物并编译无 CGO 的 Linux 二进制；小型非 root 运行镜像含 CA 证书，仅运行 Go，显式端口 8000。构建基线为 Node 24 LTS，使用 npm 与 package-lock.json，不混用包管理器。
- compose.yaml 配置环境变量、健康检查、restart 策略、合理 stop_grace_period；使用远程 Turso，不要求数据卷。
- .env.example 只提供占位符；.dockerignore 排除 .git、.codegraph、本地凭据、缓存和构建产物。
- 环境变量保留 PROXY_API_KEY、TURSO_DATABASE_URL、TURSO_AUTH_TOKEN、PORT、CORS_ALLOWED_ORIGINS；新增资源参数只在确需部署调优时引入，文档说明默认值。
- 提供离线 demo/preview 模式：本地 SQLite、示例数据与模拟上游/图片服务，不触达真实账户；不会进入生产模式或回退为模拟服务。
- 删除旧 main.ts、lib/、web/、scripts/、tests/ 下的旧 TypeScript 测试、deno.json/lock；后端替换为 Go 实现和测试，前端重新创建 React 项目与前端测试，不复用旧 TypeScript 后端或字符串模板运行时；最终移除与新实现矛盾的过期设计/计划。
- README 改为 Go/React/Docker/Turso 开发部署、管理操作、外部图片服务契约、无迁移策略及测试指令；不留 Deno Deploy 指南。
- 不自动提交、推送、发布镜像、部署或消耗真实 Agnes 额度。

## 11. React 控制台与 ui-ux-pro-max 验收契约

### 11.1 统一视觉规范

- 定位为中文运维/图片管理控制台，采用克制、清晰、适度信息密集的 dashboard 风格；不是营销落地页。ui-ux-pro-max 查询的 Data-Dense Dashboard 风格适合该场景；搜索同时给出的营销 hero/Contact Sales 布局不适用，不采纳。
- 使用中性底色、蓝色主操作、独立成功/警告/错误语义色。建立 primitive → semantic → component 三层 token；CSS 颜色集中在主题文件，组件不散落裸色值。分类不能与状态共用语义，不能仅靠颜色表达。
- 深浅主题首次跟随系统，支持手动 light/dark/system 并记住选择；两套主题分别验证对比度。普通文字至少 4.5:1，大字和非文本控件边界按 WCAG AA 至少 3:1。
- 中文优先系统字体栈，不从 Google Fonts/CDN 运行时加载资源；基础字号 16px、行高至少 1.5，次要元数据不小于 12px；ID/尺寸/计数使用等宽或 tabular-nums。
- 图标统一 Lucide SVG，纯装饰图标 aria-hidden，图标按钮有可访问名称；不使用 emoji 充当图标。
- 断点验收 375/768/1024/1440px；移动端不出现整页横向滚动。桌面侧栏、移动端 shadcn Sheet 导航；数据表在小屏切换卡片或局部可访问滚动，不把固定宽度表格撑出页面。
- 交互目标至少 44×44px、相邻目标保持至少 8px 间距；键盘焦点清晰且不被 sticky 元素遮挡。hover 不是唯一操作入口。
- 微交互通常 150—200ms，仅用于状态反馈，尊重 prefers-reduced-motion，不增加 GSAP 等装饰性动画依赖。
- 实施时将已验证 token 与组件规则写入 `design-system/agnes-console/MASTER.md`；本 spec 固定原则，精确色阶、间距与圆角由实施者按对比度验证确定，不直接持久化查询中不适配的内容。

### 11.2 导航、数据与反馈

- 深链接 `/admin/overview`、`/admin/gallery`、`/admin/accounts`、`/admin/logs`、`/admin/settings`、`/admin/login`；刷新与浏览器前进/后退可用。图库 tag 与游标、日志 category 与游标、总览日期范围保存在 URL search params。
- Query keys 必须包含筛选条件/游标/对象 ID。fetch 使用 AbortSignal；变更后精确 invalidate。定时刷新在页面隐藏时暂停；不自动重试删除/清空/导入/撤销等 mutation。
- 首次加载显示骨架，刷新保留同一筛选的数据并显示更新状态；不同筛选或不同图片不得用旧数据冒充新内容。区分空数据、筛选无结果、网络失败、无权限。
- 401 清理管理数据缓存并跳转登录；前端不持久化主 API Key、上游 Key 或会话 token。Cookie 同源请求使用 credentials=same-origin。
- 表单可见 label、辅助说明与字段级错误；提交中禁用重复提交，失败保留用户输入。破坏性操作使用 AlertDialog 明确对象与后果，成功后通知且同步列表，不仅改变本地 UI。
- 后台富化任务显示运行/完成/失败状态与 processed/succeeded/failed 计数；运行中按钮禁用，刷新页面后从服务端恢复任务状态，aria-live 使用 polite 且不按每个轮询重复朗读。

### 11.3 五个业务页面

- 总览：日期范围、请求/成功/部分成功/失败/图片统计、每日请求趋势、模型用量表与账号健康摘要。计数满足 §5 的统计关系，部分成功不能再次累加到成功总量。
- 数据可视化遵循 dataviz： headline 用数字卡，不用伪柱图；每日请求量使用单系列折线与独立图片量折线（不双轴），缺失日期补 0，UTC 日期。图表有键盘可达 tooltip、同源数据表视图和无数据状态。系列颜色保持稳定，浅/深背景分别验证；将来增加多系列时必须有图例与非颜色编码。不新增与现有指标无关的图表。
- 图库：按 UTC 日期分组、分类筛选、24 项游标分页/加载更多；固定占位尺寸与懒加载缩略图。分类中文名为普通/绘画/性感/色情/动漫色情/未分类，仍使用对应英文 tag 做 API 值。
- 原图 Dialog：标题与描述可访问，键盘/Escape/焦点恢复交给组件；打开或切换图片时旧图立即退出当前显示，显示加载状态，过期响应不得覆盖新图。缩略图失败仅回退原图一次；下载与弹窗始终使用原图，网络失败有重试/错误提示；对象 URL 及时释放。
- 账号：脱敏 Key、健康/冷却状态、上游调用/图片计数；新增/编辑、批量导入、单个/批量探测、启停/删除/解除冷却。导入说明同账号 Key 不叠加额度；密钥编辑空值表示不更改，响应绝不返回完整 Key。
- 日志：request/enrich 分类筛选、时间/状态/耗时/请求 ID/模型/尺寸/数量，逐账号尝试详情，清空确认；宽屏表格、小屏摘要卡，状态有文字与图标。
- 设置：上游、尺寸与参考图位置、重试/超时、刷新、图片服务分组；图片服务未配置解释关闭行为；默认响应为 URL 只做说明，不做灰色不可编辑的冗余选择框；提供撤销全部会话入口并明确需要重新登录。

### 11.4 SPA 与构建安全

- Vite base 与 Router basename 为 `/admin/`；资源路径为 `/admin/assets/*`。Go 仅对管理页面 GET/HEAD 路由返回 SPA index；未知 `/admin/api/*` 和不存在的资源返回 JSON/404，禁止以 index.html 冒充资源。
- Go embed 的产物目录为 `internal/webassets/dist/`；Vite 输出到该目录，单一产物不复制到第二个目录。源码和 lockfile 提交，构建产物/node_modules 不提交。未构建前端时 Go 编译可明确失败，文档给出先构建前端的命令；不增加空白 UI 占位回退。
- CSP 脚本与样式文件只允许同源，`script-src 'self'` 禁止 unsafe-inline/unsafe-eval；`style-src 'self'` 不允许任意内联 stylesheet，单独 `style-src-attr 'unsafe-inline'` 仅用于 React/Radix 动态定位和尺寸属性（不放宽脚本策略）。实施时在真实浏览器验证 Dialog/Select/图表不会被 CSP 阻断。图片 img-src self blob: data:，不运行时依赖 CDN，不允许源 URL 作为任意外链图片绕过内容端点。
- HTML 与管理 API no-store；带 hash 的静态资源可 immutable 缓存。无哈希资源不套用长缓存；会话注销后不留下缓存中的账号/日志数据。

## 12. 验收

- gofmt 检查、go vet、go test ./...；有可用 race 工具链时运行 go test -race ./...。
- 前端：npm ci、类型检查、ESLint、Vitest/Testing Library 单元与组件测试、Vite production build；Playwright + axe 验证页面与关键交互。
- SQL 离线集成：初始化/拒绝非兼容库、账号原子 claim/CAS、日志/用量一致性、BLOB 往返、会话撤销、图库游标。
- HTTP 模拟：JSON/multipart/data URI、尺寸/ratio/auto、请求边界、协议错误、429/超时/故障切换、n 并发与部分成功、客户端取消。
- Edge-Images 模拟：真实形状的顶层数组、元数据降级、五分类、URL→base64 单次回退、批量预算、补齐单遍与进度。
- 安全：Cookie/Bearer 隔离、Origin、CORS、密钥脱敏、登录限速、SSRF/IP/重定向/读头边界、图片 MIME 与响应安全头。
- 生命周期：背压、退出排空、队列拒绝的可观察结果、不同请求并发数据竞争。
- UI：375/768/1024/1440px 截图人工检查；深浅主题对比度、键盘完整流程、Dialog 焦点恢复、刷新深链接、图片快速切换竞态、任务状态恢复、表单错误与破坏性确认、图表数据表与空态。
- 编译 Linux 无 CGO 二进制，离线 preview 启动并实测 health、登录、管理页及模拟图片请求。
- 当前环境已检测 Go 1.26.1、Node 24.22.1、npm 11.6.3；未找到 Docker 命令。若后续仍不可用，明确报告 Docker 构建/运行未验证，不用 Linux 交叉编译冒充镜像验证。真实 Turso/Agnes 集成只在用户提供凭据并授权后运行。

## 13. 非目标

旧数据库迁移、旧路由/DTO 兼容、Deno/Node 生产运行时、模型映射、mask 局部重绘、流式输出、本地图片转码/缩放、自动图库清理、分布式任务服务、自动真实付费测试、SSR/SEO、独立前端部署。
