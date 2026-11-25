# WebUI 回退设计规格

- 日期：2026-11-25
- 状态：文档交付；尚未实施，当前不执行任何实现任务。
- 视觉基线：`7387e35^`（`c3bbc5d`）中的 `web/`。
- 后端基线：当前 `a4882a5`；实施前重新确认 HEAD 和 API 契约。
- 配套计划：[`../plans/2026-11-25-webui-rollback.md`](../plans/2026-11-25-webui-rollback.md)。

## 1. 意图与范围

用户认为 `7387e35` 引入的 React SPA 过于简陋，希望恢复迁移前的 WebUI。该提交同时完成了 Deno → Go 后端重写，因此本次不能整次 revert，也不能将仓库重置到旧提交。

已确认的产品范围：恢复旧版界面的布局、配色与交互，移除 React SPA；将旧界面适配当前 Go API；保留后续新增的存储初始化、ImgBed、本地原图存储、限时签名链接和 `PUBLIC_ORIGIN`。

**当前交付仅为 spec 与 plan。** 不实施、不安装依赖、不运行测试或应用、不启动子代理、不打开浏览器、不提交或推送。文档中的实现与验收步骤只供未来另行授权使用。

## 2. 目标与非目标

### 目标

1. 恢复旧版深浅主题、绿色强调色、桌面侧栏、顶部操作区、移动端底部导航，以及旧版卡片、表格、弹窗、图库灯箱。
2. 保留总览、图片、账号、日志、设置五个板块及其原有主要交互。
3. 使用当前 Go API，不恢复旧 Deno 后端或旧数据模型。
4. 将当前存储初始化和新增设置融入旧版组件语言，而不是复用 React 页面的外观。
5. 保持 Go 单二进制部署、静态资源嵌入、离线 preview 和现有容器运行约束。

### 非目标与禁止事项

- 不重新设计另一套界面，不以“优化”为理由更换旧版风格。
- 不迁移、重建或清空数据库，不更改 schema、原图文件或图床记录。
- 不修改图片生成、账号池、富化服务、签名交付和认证的后端契约。
- 不恢复 Deno，不保留第二套 React 控制台并行运行。
- 不更改 Compose、GHCR 发布或 `PUBLIC_ORIGIN` / 可信反代语义。
- 不重写 Git 历史，不自动提交、推送或合并。
- 不把源代码中的旧占位字段伪装成当前后端可提供的数据。

## 3. 界面基线

直接复用旧提交中 `web/styles.ts`、`web/icons.ts`、`web/theme.ts`、`web/ui.ts`、`web/login.ts`、`web/console.ts`、`web/runtime.ts`、`web/gallery.ts` 和 `web/sections/*.ts` 的视觉与结构。

- 保留深色强调色 `--accent: #22c55e`、浅色主题、系统字体、内联 SVG 图标和主题记忆 `agnes-theme`。
- 保留 `data-section` 五板块结构、侧栏导航、移动导航、自动刷新开关、确认弹窗与 toast。
- 保留图库日期分组、筛选、分页、懒加载、灯箱左右切换和键盘操作。
- 新增初始化页沿用旧登录页/表单卡片风格；存储设置沿用旧设置面板的字段、按钮与提示样式。
- 可以修正失效契约、过时文案和新增字段所需布局；不能将这些必要适配扩大成风格重设计。
- 不能提供的数据应隐藏或标为不可用，不填造假的时间、错误或容量。

## 4. 技术方案（实施建议，非新增用户要求）

沿用 Go 1.26 后端，恢复 HTML/CSS/原生浏览器 JavaScript。旧 TypeScript 模板放入 `frontend/web/`，使用 Node 24 内置 TypeScript 支持执行构建，生产运行仍不需要 Node。

构建通过 `frontend/scripts/build.mjs` 渲染文档并将模板中的脚本块、样式块提取为同源、内容哈希命名资源，输出：

```text
internal/webassets/dist/
  index.html          # 五板块旧控制台
  login.html          # 旧风格登录页
  setup.html          # 同风格存储初始化页
  assets/*-<sha256>.js
  assets/*-<sha256>.css
```

- 不使用 React、React Router、TanStack Query、Tailwind、Radix、Vite；不新增前端运行时依赖。
- Node 内置 test runner 用于模板、构建和协议适配测试；Playwright 与 axe 仅作为开发测试依赖。
- 构建路径相对脚本定位，不依赖命令调用目录。
- 主题初始化脚本须在样式首次绘制前执行；其他脚本保留 runtime → 就绪检查 → 板块注册 → shell 的顺序。
- 不用 `eval`、`new Function` 或放宽 CSP 来执行旧脚本。
- Go 继续通过 `internal/webassets.FS()` 嵌入构建目录，不引入缺失构建的占位回退。
- 构建清理仅限指定输出目录；不得清理 `DATA_DIR`、源码目录或其他 worktree。

## 5. 页面路由与认证

### 页面分配

| 路径 | 文档 / 行为 |
|---|---|
| `/admin`、`/admin/` | `index.html`，默认总览 |
| `/admin/overview`、`gallery`、`accounts`、`logs`、`settings` | `index.html`，打开路径对应板块 |
| `/admin/login` | `login.html` |
| `/admin/setup` | `setup.html` |
| 未知页面、缺失资源、未知 `/admin/api/*` | JSON 404，不回退 HTML |

旧版 `/admin#gallery` 等 hash 导航继续有效。若 URL 同时有已知板块 hash 和路径，以已知 hash 为准；未知 hash 不覆盖已知路径。导航使用旧版 hash 交互，并保持刷新后仍打开相同板块。

### 启动与重定向

1. 主题脚本可以立即运行；控制台内容在认证/初始化判定完成前不展示，管理板块不得启动轮询。
2. 先 `GET /admin/api/session`；未登录转登录页。
3. 登录成功以 `{apiKey}` 请求 `POST /admin/api/session`，再读取存储状态。
4. `GET /admin/api/storage` 未初始化时进入 setup；初始化后进入原请求板块，默认总览。
5. 已登录访问 login 时按存储状态跳转；已初始化访问 setup 时跳到控制台。
6. 保留返回目标的参数只能接受同源、已知的控制台路径/hash；不能形成外站重定向或包含密钥。
7. 运行中遇到 401，停止轮询并转登录；遇到 `503 initialization_required`，停止正常板块请求并转 setup。
8. 其他 403/503 或网络错误展示可重试错误，不能误判成未登录或擅自初始化。
9. 单浏览器退出用 `DELETE /admin/api/session`；撤销全部会话用单独的 `POST /admin/api/session/revoke`，两者不能混淆。

登录密钥、会话令牌、ImgBed Token 不写入 URL、localStorage、sessionStorage、日志或展示文本；必要输入仅暂留在表单内，成功、退出或离开页面后清除。服务端持久化和 HttpOnly Cookie 行为保持不变。

## 6. 当前 API 适配

契约依据：`docs/api/admin.openapi.yaml`、`internal/httpapi/`、`internal/domain/` 和现有 Go 测试。若文档与实现不一致，先核对实际 handler 和测试；不为迁就旧 UI 改后端。

### 6.1 账号

- 列表读取 `{items}`；批量测试读取 `{items}`，单账号测试读取 `message`。
- 创建、修改、删除、启停、测试、冷却重置继续使用当前路径和请求。
- 导入文本在客户端按旧版 `名称,密钥` 格式解析：跳过空白行、裁剪字段、按第一个逗号拆分，保留原始行号。
- 发送 `{accounts:[{name,apiKey}]}`；读取 `{imported,errors:[{index,message}]}`，将数组索引映射到原输入行。
- 超过 1000 条或请求 JSON 超过 1 MiB 时阻止提交并明确提示；空字段/缺逗号不静默丢弃，提示对应行且不提交有格式错误的批次。
- 脱敏 Key 和健康状态保持真实；不将明文密钥保留在列表状态中。

### 6.2 总览

- `?day=` 已不可用，使用 `start`/`end`（包含边界、YYYY-MM-DD，最大 366 天）。
- 为恢复“所选日指标 + 14 日趋势”，使用两个请求：`[D,D]` 与 `[D−13,D]`；不得将 14 日汇总误当单日指标。
- 趋势读取 `days`，模型名称读取 `models[].model`；无 `lastUsedAt` 时不构造模型最近使用时间。
- 健康读取 `total/healthy/cooling/disabled`，启用数为 `total-disabled`；用“冷却”取代旧的不可对应降级字段。
- 保持当前指标含义：`successes` 包含部分成功，完整成功为 `successes-partials`；`images` 不是成功子请求数。
- 日键按后端 UTC 口径运算，避免本地时区/DST 改变请求日期；UI 可明确说明统计时区。

### 6.3 日志

- 读取 `{items,nextBefore}`；历史分页按 cursor 获取，每页采用 50 条，不超过上限 100。
- 分类仅发送 `request` 或 `enrich`；“全部”省略 category。
- 账号、状态、错误码与消息从 `attempts[]` 读取，不访问已删除的顶层 `accountName/error/errorCode`。
- 交付失败展示 `deliveryFailures[]` 的 `subrequestIndex/imageIndex/stage/status/code`，区分 `download` 与 `persist`。
- 部分成功使用 `partial`；无法通过输出图片数反推子请求成功数。
- 搜索限于已加载日志；不暗示具有后端全库搜索能力。刷新合并新条目，不丢失已加载旧页或重复 ID。
- 清空日志须确认；不声称清空会重置总览 usage。

### 6.4 图库和补齐

- 字段替换：`ts → createdAt`、`tag → nsfwTag`、`nsfw → nsfwScores`；未分类筛选值为 `unclassified`。
- 保持 `{items,nextBefore}` 与 24 项分页；搜索限于已加载图片，筛选变化重置 cursor，刷新合并新条目。
- 不再依赖不存在的 `hasThumbnail/mime/byteSize/enrichError`。
- 首先读取鉴权 thumbnail；明确 404 才一次性回退到鉴权 original。401/503 不作为缩略图不存在处理；original 失败显示占位与错误，不递归重试。
- 原图查看、复制/下载不得依赖外部 `sourceUrl`；下载使用 `/admin/api/gallery/{id}/content?download=1`，由服务端 Content-Disposition 决定正确扩展名。
- 单删、清空均确认；清空失败须提示可能部分完成并重新读取列表，不宣称全部成功。
- 补齐只发一次 `POST /admin/api/gallery/enrich`，202 后 `GET` 轮询；不恢复旧的客户端分页 POST 循环。
- 状态读取 `running/startedAt/finishedAt/processed/succeeded/failed/error`，每次替换累计快照，不能累加相邻轮询计数。
- 页面重载恢复已有任务；409 `enrichment_running` 后读取当前任务；完成后刷新图库；图片服务未配置则提示不可用。
- 普通板块自动刷新只作用于当前板块，遵循开关、页面隐藏和文本选择暂停；已有补齐任务的低频状态追踪不因切换板块而重复启动。

### 6.5 普通设置

PUT 是完整替换，必须提交以下 14 个字段，不夹带 storage 或旧字段：

`agnesBaseUrl`、`defaultSize`、`imageParamMode`、`probeModel`、`probeConcurrency`、`requestTimeoutMs`、`autoRefreshIntervalMs`、`maxAttempts`、`imageServiceBaseUrl`、`thumbnailWidth`、`thumbnailQuality`、`enrichTimeoutMs`、`imageUrlTtlHours`、`imagePublicBaseUrl`。

- 移除 `defaultResponseFormat` 控件与 payload；旧“b64_json 不可用”文案删除，当前图片 API 仍支持显式 b64_json。
- `imageUrlTtlHours`：整数 1–720，默认 24；保留图片公开 origin 的设置及含义。
- 其他字段范围按当前 OpenAPI，表单保存不得重置未改动字段。
- 自动刷新不得覆盖脏表单或正在编辑的秘密输入；保存成功后更新已确认状态。
- 普通设置与存储配置使用各自接口、各自保存按钮；不能跨接口暗示原子成功。

## 7. 存储初始化与设置

### 初始化

- 必须显式选择，本地和图床均不默认勾选；未选择时不能提交。
- local 请求严格为 `{mode:"local"}`，不带 ImgBed 字段。
- imgbed 请求为 `{mode:"imgbed",imgbedBaseUrl,imgbedToken}`；地址为 HTTPS origin、Token 必填，提示需要 upload/delete 权限。
- 标明选择写入后不能切换，不暗示前端会迁移历史图片。
- 201 后读取确认状态并进入控制台；409 `already_initialized` 时重新 GET，尊重其他管理员已固定的模式。
- 不把格式校验通过描述为图床连接/权限验证成功；初始化接口不探测真实图床。

### 已初始化设置

- 显示只读存储方式；local 不显示 ImgBed 更新控件。
- imgbed 显示地址、`hasImgbedToken` 对应的配置状态和空白的新 Token 输入。
- PUT `{imgbedBaseUrl,imgbedToken?}`；Token 留空时省略，不发送 null，不回显旧 Token。
- 明确提醒修改图床地址不会迁移原图，新地址须已包含同一套文件。
- `not_initialized` 重新读取并跳 setup；`storage_mode_fixed` 重新读取并显示实际只读模式。

## 8. 静态服务与安全

- 保持 `NewAssets(fsys fs.FS) http.Handler` 接口和已知页面白名单。
- 页面 `Cache-Control: no-store`；哈希资源 immutable，非哈希资源重新验证。
- 保持 `script-src 'self'`、`style-src 'self'`；仅保留已有 `style-src-attr 'unsafe-inline'` 支持旧版静态/动态 style 属性。
- 保持 `nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、禁止嵌入和路径穿越；GET/HEAD 外返回 405，HEAD 无响应体。
- 图像响应 sandbox CSP 保持原样；不放宽图片或参考图 SSRF 策略。
- 外部返回的 prompt、账号名、错误文本用 textContent/安全转义，不拼入可执行 HTML。
- API mutation 继续发送同源 Cookie 和当前浏览器 Origin，`PUBLIC_ORIGIN` 的服务端检查不变。

## 9. 构建、部署与文件边界

- 只修改前端、静态页面分配、相关测试、Docker 前端构建阶段和 README。
- Docker 的 Go build、nonroot UID/GID 65532、DATA_DIR、卷、健康检查、启动入口不变。
- 生成目录 `internal/webassets/dist/` 保持 git-ignored；`.codegraph/` 不修改、不创建索引。
- 删除 React 源码、依赖和专属配置前检查 tracked 清单；保留 Go contract fixtures、Playwright 启动脚本和当前可复用测试场景。
- README 更新为原生控制台栈及实际 build/test 命令，不继续说明 Vite dev server。
- 未来若使用子代理，直接继承当前授权 worktree，不叠加 agent worktree isolation；参数错误不得反复重试。此条仅为未来执行约束，本次不启动代理。

## 10. 验收标准（未来执行）

1. 从干净 checkout 构建能生成三份文档和外置哈希资源，Go/Linux 无 CGO 构建通过；缺失构建明确失败。
2. 对照旧模板确认布局、双主题、绿色强调、导航、表格与灯箱恢复；不存在 React bundle 或前端运行时依赖。
3. 首次访问、过期会话、直接路径、hash 和安全返回目标均正确；认证前不发送正常管理查询。
4. 账号 CRUD/导入/测试/重置、单日指标与 14 日趋势、日志分页和交付错误详情全部按当前契约工作。
5. 图库分页、筛选、下载扩展名、thumbnail 回退、部分删除失败和后台补齐恢复正确。
6. local/imgbed 初始化、冲突恢复、模式固定、空 Token 保留、14 字段完整 settings 保存均有行为测试。
7. 375px 与桌面、双主题、键盘和 axe 检查通过；正常操作无 JS/CSP 错误，异常路径有明确提示。
8. `go vet`、`go test -p 1 ./...`、Node tests、Playwright E2E、`git diff --check` 通过，或明确记录不可用检查。
9. 只使用离线 preview/模拟 API，不读取生产数据或消耗真实额度。
10. 未来另行授权实施且全部任务完成后，再启动 preview、打开浏览器供用户验收；不提前启动。浏览器验收不等于提交、合并或发布授权。

## 11. 文档审查与待实施事项

本规格基于已确认范围、已完成的只读 API 差异核对及当前 OpenAPI整理。技术组织由执行者建议；用户未要求特定构建工具。已检查 scope、契约字段、路由、敏感信息、部署不变项和计划依赖。

未实施、未运行实现测试、未做新的子代理审查。实际视觉效果和浏览器行为必须在未来实现后验证，不能把文档完成标记为回退完成。
