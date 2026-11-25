# 管理面板生图控制台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native implementation, or superpowers:subagent-driven-development if explicitly chosen. Steps use checkbox syntax for tracking.

## Context

管理员需要在现有后台直接手动生图，不再借助外部客户端。设计已确认：参考 AstrBot 生图插件的 7:5 双卡片布局，左侧配置，右侧单张大图和数字切换；不建立任务系统。图库详情在“复制提示词”旁增加“作为参考图”，用于追加原图并返回生图控制台。

**Goal:** 新增可用的管理员生图页面，复用现有生成、日志和归档链路，并完成图库到参考图的联动。

**Architecture:** 保留现有 Go HTTP 服务和 TypeScript 静态 HTML/脚本生成架构。新增 `/admin/api/images/generations`，沿用 `Auth.Admin` 并调用已有 `handleImageRequest`；前端新增 `generate` section，复用 bootstrap readiness、runtime API、主题和图库原图，不引入 UI 框架、任务存储或 schema 变更。实现阶段对 spec 的技术细节做一处必要调整：页面使用已有 `b64_json` 输出转本地 Blob 预览，而不是 URL 输出（现有严格 CSP 禁止外部 img-src，公共图片 origin 可能不同源）；不改变用户确认的可见行为，也不放宽 CSP。执行前同步设计说明中的这一内部交付选择。

**Tech Stack:** Go、现有 TypeScript/plain JavaScript、Node test runner、Playwright、现有本地 mock preview。

**Spec:** `docs/superpowers/specs/2026-11-26-admin-image-generation-design.md`（已获用户确认）。

## Global Constraints

- 不添加任务记录、队列、取消、状态徽章、进度或耗时展示；仅提交按钮显示等待，错误留在左表单。
- 右侧是完整等比大图与数字按钮，无下载、转参考图、缩略图网格或新增结果 lightbox。
- “图片”详情按钮顺序：复制提示词 → 作为参考图 → 下载 → 删除；原有行为不变。
- 参考图限额：16 张、每张 20 MiB、完整 JSON 请求 32 MiB（包括 Base64 和 JSON 开销）；后端校验仍是权威边界。
- 档位 1K/2K/3K/4K；比例 1:1、3:4、4:3、16:9、9:16、2:3、3:2、21:9；默认数量 1，默认档位来自设置，默认比例 1:1。
- 跟随参考图需要第一张图；自定义 WxH 归一化，不承诺精确输出，不修改上游尺寸语义。
- 不新增数据表、兼容层、前端框架或敏感表单 localStorage 持久化。
- 不访问付费生图上游。测试与演示使用现有 mock 服务。
- 保留既有未跟踪 `.codegraph/` 和旧计划文件；忽略 `.superpowers/`。未经用户另行要求，不 commit/push、不创建 worktree。

## Review Focus

1. 两个异步参考图添加动作同时完成，或切换图库详情后请求才完成：按点击时图片快照追加，串行更新，失败不影响已有项。
2. 原始文件总量看似合规但 Base64/JSON 超限：客户端发送前准确计算，后端二次校验，不发起超限请求。
3. 会话过期/未初始化/跨源 Cookie 提交：复用现有认证与 bootstrap，不能放宽数据面 Cookie 访问。
4. 已有结果时再次生图失败：旧图、当前选中编号、表单和参考图保留，按钮恢复，失败后可以重试。
5. 图片 URL 预览失败、图库原图缺失/格式不支持、页面退出后异步读取完成：不误判远程图、不泄漏 object URL，不追加错误图片或误跳转。

---

## 文件与职责

- `internal/httpapi/admin.go`：新增管理端生图分发，复用 `router.handleImageRequest`。
- `internal/httpapi/assets.go`、`assets_test.go`：`pageDocuments` 增加 `/admin/generate`，保留严格现有 CSP。
- `internal/httpapi/admin_generation_test.go`：管理端认证、方法、body/服务缺失边界及真实生成交付复用测试。
- `frontend/web/generation.ts`：生成 section HTML、对话框、页面控制器和脚本安装。
- `frontend/web/generation-contracts.ts`：可测试的请求构造、尺寸估算及参考输入预算。
- `frontend/web/generation-references.ts`：参考图文件/原图读取、URL 预览与资源生命周期。
- `frontend/web/generation-style.ts`：局部样式，使用现有 CSS variables。
- `frontend/web/console.ts`、`ui.ts`、`contracts.ts`、`icons.ts`：导航、脚本/样式安装、登录回跳 whitelist 与生成图标（复用 plus/bolt 图形或加 generate sprite，不引用不存在的图标）。
- `frontend/web/runtime.ts`：在现有 API 上补充成功响应的 Blob 读取能力，仍通过 bootstrap gate。
- `frontend/web/gallery.ts`：详情新增按钮，调用生成控制器的图库引用入口。
- `frontend/tests/generation*.test.mjs`、既有 `build.test.mjs` / `contracts.test.mjs`：纯逻辑和页面控制器测试。
- `frontend/e2e/generation.spec.ts`、相关已有 E2E：浏览器交互与无障碍验收。
- `internal/webassets/dist/`：通过原构建脚本更新哈希产物，不手改生成文件。
- `.gitignore` 已忽略 `.superpowers/` 与 `internal/webassets/dist/`，无需修改或 force-add；`README.md` 更新功能说明；计划完成执行时归档到 `docs/superpowers/plans/2026-11-26-admin-image-generation.md`。

### Task 1：管理端生图入口

**Consumes:** `Auth.Admin(http.Handler) http.Handler`、`router.handleImageRequest(http.ResponseWriter, *http.Request)`、`images.Parse` 和现有生成交付测试 fixture。
**Produces:** `POST /admin/api/images/generations`，请求和响应与现有 generations 一致，支持管理 Cookie+同源校验或有效 Bearer。

- [ ] 写失败测试：有效同源管理员 Cookie 生成返回 200 和图片 URL，结果可读，原图库/日志有对应记录；匿名/错误 Bearer 返回 401，跨源 Cookie 返回 403。
- [ ] 写方法/可用性测试：GET/PUT 返回 405，额外路径返回 404，未初始化返回 503，`Images == nil` 返回 503 而不是 panic；有效 Bearer 保持既有管理授权，公共 `/v1/images/generations` 仍不接受 Cookie。
- [ ] 写 body 测试：管理入口接受超过管理通用 1 MiB、但低于生图 32 MiB 的合法参考请求；非法字段/数量/超限请求返回已有 parser 错误，引用现有 HTTP image tests 的真实 service seam。
- [ ] 生图入口 body 测试可复用现有 HTTP test helpers，固定以下接口结果，不能只用假 router 绕过认证：
  ```go
  // 表驱动 cases: valid cookie + same origin -> 200; anonymous -> 401;
  // wrong bearer -> 401; cross-origin cookie -> 403; valid bearer -> 200;
  // cookie sent only to /v1/images/generations -> 401.
  if recorder.Code != tc.wantStatus { t.Fatalf("status=%d, want=%d: %s", recorder.Code, tc.wantStatus, recorder.Body.String()) }
  // 成功 case 解码 ImageResponse：Data 非空；url 模式 URL 非 nil，
  // b64_json 模式解码所得 PNG/JPEG/WebP bytes 与归档原图一致。
  // ListGallery 与 ListLogs 具有同一请求的输出和日志。
  ```
- [ ] 运行 `go test ./internal/httpapi -run 'TestAdminGeneration' -count=1`，确认新增入口缺失导致失败。
- [ ] 在 `handleAdmin` 增加 `images` 的严格路径分发，只允许 POST，检查生成服务可用，再调用 `handleImageRequest`。不使用 `decodeAdminBody` 的 1 MiB 限额、不转发内部 HTTP、不改 `Auth` 或公共路由。
- [ ] 重跑新增测试与 `go test ./internal/httpapi ./internal/service ./internal/images -count=1`，确认通过。

### Task 2：请求/尺寸/参考图的可测试契约

**Produces:** 自包含 plain-JS exports（JSDoc，便于 `.toString()` 嵌入）：
- `generationPayload(form, references) -> {model,prompt,n,size,ratio?,images?,response_format:"b64_json"}`，无效输入抛出可读 `Error`。Form 字段固定为 `{prompt,model,n,sizeMode:"tier"|"auto"|"custom",tier,ratio,width,height}`；references 是下述 Reference item 列表。
- `expectedGenerationSize(tier, ratio) -> {width,height}`，数值与 `internal/images/size.go` 的 `baseSizes`/`tierScale` 一致。
- `createGenerationReferences(win, api) -> {items,addFiles(files),addURL(url),addGalleryImage(item),remove(id),move(id,delta),dispose()}`；添加方法返回 Promise，任何提交使用最终 items 快照。图库输入 item 为现有 `GalleryItem` JSON 摘要，按 `item.id` 读取原图。所有异步添加在同一串行链上排队；失败不得阻断后续添加。
- Reference item：`{id,kind:"file"|"url"|"gallery",name,value,previewURL,bytes?,galleryId?}`，value 为现有 parser 接受的 Data URI 或 HTTP(S) URL；仅本地产生的 preview object URL 需要 revoke。`items` 提供实时只读快照，避免替换列表后控制器仍使用过期数组；dispose 为幂等动作。
- 所有被嵌入 `.toString()` 的 exports 必须自包含，不隐式引用模块级 imports/常量；在 Node tests 中将导出函数源码重新放入隔离 VM 运行同一契约测试，防止测试可用而浏览器脚本 ReferenceError。

- [ ] 写 Node tests：默认 1 和合法模型/trimmed prompt；非整数 n、空提示词、空模型被拒绝；8 比例×4 档位预计尺寸正确；auto 无首图拒绝；custom 请求只发送 WxH、不附 ratio；基础模式只发档位/比例。
- [ ] 写参考管理 tests：PNG/JPEG/WebP 文件+URL+图库原图加入、顺序调整决定第一张、同图库 ID 去重、16 张/20 MiB 边界、Base64/完整 JSON 32 MiB 边界、并发添加串行化、失败保留已有列表，删除/销毁释放资源且拒绝销毁后的迟到添加。
- [ ] 在纯契约 tests 中对 32 MiB 最终 JSON 预算使用可控长度输入：`<= 32 * 1024 * 1024` 可提交、`> 32 * 1024 * 1024` 拒绝；含中文提示词和引号/转义的 URL，以 UTF-8 实际序列化长度判定，不能只累加文件 bytes。异步参考图批量添加超限采用整批验证、整批提交，失败时释放临时预览而不留下半批新增项。
- [ ] 纯契约测试至少固定以下断言（其余情形按上一项添加）：
  ```javascript
  const form = { prompt: "  forest  ", model: "agnes-image-2.5-flash", n: 1,
    sizeMode: "tier", tier: "2K", ratio: "4:3", width: 1536, height: 1024 };
  assert.deepEqual(generationPayload(form, []), {
    prompt: "forest", model: form.model, n: 1, size: "2K", ratio: "4:3", response_format: "b64_json",
  });
  assert.deepEqual(expectedGenerationSize("2K", "4:3"), { width: 2304, height: 1728 });
  assert.throws(() => generationPayload({ ...form, n: 1.5 }, []));
  assert.throws(() => generationPayload({ ...form, sizeMode: "auto" }, []));
  assert.equal(generationPayload({ ...form, sizeMode: "custom" }, []).size, "1536x1024");
  assert.equal(generationPayload({ ...form, sizeMode: "custom" }, []).ratio, undefined);
  ```
- [ ] 运行 `node --test frontend/tests/generation-contracts.test.mjs frontend/tests/generation-references.test.mjs`，确认因缺失模块而失败。
- [ ] 实现纯请求构造/校验：数字必须安全正整数；不加公共接口没有的任意数量上限；用 `TextEncoder` 对最终 JSON 计算准确预算。自定义 WxH 沿用 parser 可表示的正整数格式。
- [ ] 实现参考管理器：本地二进制验证/转换复用后端支持的签名语义，不信任 file MIME；使用 FileReader/Data URI 和 object URL 预览；HTTP(S) URL 拒绝凭据和非法协议，以图片占位及 URL 文本显示（现有 CSP 只允许 self/blob/data 图片，不发起浏览器跨源 fetch 或为预览放宽 CSP）；后端仍可按现有安全规则处理远程引用。图库按 ID 获取 `/admin/api/gallery/{id}/content`（现有原图端点），不使用缩略图或 sourceURL。
- [ ] 补充 runtime `api(path, options)` 的 `responseType:"blob"` 分支：成功返回 Blob，失败继续解析既有 API JSON 错误；删掉该内部 option 后交给 fetch，由现有 bootstrap gate 和重定向统一处理。不新增独立绕过鉴权的 fetch helper。
- [ ] 重跑新 tests 与现有 bootstrap tests，确认通过且 API JSON 默认行为不变。

### Task 3：生图页面与大图数字切换

**执行前：** 调用 `ui-ux-pro-max:ui-ux-pro-max`，按已批准布局检查表单可访问性、响应式及状态反馈；不要因此迁移框架或重做设计。产品代码开始前按 `superpowers:test-driven-development` 走红/绿测试。

**Consumes:** Task 2 exports、`A.api`、`A.ready`、`A.el`/`iconNode`/`setBusy`/`toast`，现有 CSS variables。
**Produces:** `mountGeneration(win, helpers) -> controller`（自包含可嵌入 JS）；helpers 固定为 `{generationPayload,expectedGenerationSize,createGenerationReferences}`，runtime 从 `win.Agnes` 取得。安装 `A.generation = {addGalleryImage(item):Promise<void>, isBusy():boolean}`（addGalleryImage 仅追加并重绘，不自行导航；正在提交/导入时拒绝修改）；`generate` section，`A.navigate(name)` 暴露 Shell 既有 navigate。控制器用一个包含待上传与提交的 busy 状态防止竞态；settings 只在首轮初始化应用默认值。

- [ ] 写控制器/构建失败 tests：导航两套均包含 generate；安全登录目的地支持 `/admin/generate` 与 `/admin#generate`；表单/结果区域均出现，结果区域没有下载/转参考图/任务状态。
- [ ] 写控制器状态 tests：bootstrap 未就绪不请求；模型与 defaultSize 首次初始化，不覆盖用户后续修改；只一次提交；提交中冻结配置/参考修改且保留旧预览；成功使用实际返回数量生成数字按钮、重置第一张；失败保留旧图及选中索引并恢复输入；清空预览不请求删除 API；含 HTML 的提示词/文件名/后端错误按文本显示；混合文本和图片的粘贴不破坏普通提示词粘贴行为；合法 b64_json 转换为 Blob 后支持当前页面外的公共 origin 配置而不放宽 CSP；缺失/损坏 Base64 响应不替换上一轮图，释放部分转换生成的 object URL。
- [ ] 在结果转换测试中使用 PNG、JPEG、WebP 三种 Base64 fixture，断言 Blob MIME 分别为 `image/png` / `image/jpeg` / `image/webp`，损坏或未知签名被拒绝；结果体超过参考图 20 MiB 但未超过既有输出 64 MiB 不应被误拒绝。
- [ ] 运行 `node --test frontend/tests/generation.test.mjs frontend/tests/build.test.mjs frontend/tests/contracts.test.mjs`，确认失败。
- [ ] 实现 left form：prompt、model/n/ratio/size 参数行、折叠尺寸模式、上传/drop/paste、URL 输入、图库分页选择 dialog、引用网格及查看/移除/前后排序；重用现有对话框/图标/错误模式。粘贴只有有图片时才 preventDefault，不吞文本提示词粘贴；尺寸模式切换时禁用不适用控件（auto 禁 ratio/custom 输入，custom 禁 tier/ratio），重新回到 tier 模式保留之前档位和比例。单图不显示无意义的数字切换。
- [ ] 实现 controller 请求：ready 后读取 `/v1/models` 和 settings；构造最终 JSON、POST 管理入口；结果大图 `contain`、数字按钮、初始空态。右侧不新增任何任务或图片操作。前端请求 `response_format:"b64_json"`，后端直接复用已有 Base64 交付，浏览器校验并生成本地 Blob/object URL；如此无需对配置的跨源公共图片地址放宽 CSP/CORS，不增加返回 schema。成功响应先完整校验/转换才替换旧图；转换失败保留旧图；替换/清空/退出释放结果 object URL。
- [ ] 生成页面仅展示最终图片，不显示或暴露远程危险链接。Base64 响应是原始编码（不是 Data URI，且响应不含 MIME），解码后按 PNG/JPEG/WebP signature 判断 MIME 再创建 Blob，不能默认全部 image/png；结果沿用交付最大 64 MiB，而非参考图 20 MiB 限额。提示词、文件名及后端错误均用 `textContent`，不以 `innerHTML` 插入外部字符串；传入参考 URL 仅允许 HTTP(S)，预览使用本地受控 Data URI 和 object URL，不引入 inline handler、外部 CDN 或放宽 CSP。
- [ ] 实现 7:5 局部 CSS、深浅色、参数行换行、窄屏上下排列、数字按钮换行、keyboard/focus/alt；加入 ui/console 的生成脚本/样式，更新 safeAdminDestination 与导航 whitelist；`internal/httpapi/assets.go` 的 `pageDocuments` 添加 `/admin/generate` 并测试直接访问返回控制台；移动端原五列导航网格适配六项。同步 `frontend/tests/build.test.mjs` 的 SECTIONS 与导航数断言、`frontend/e2e/helpers.ts` 的 SECTIONS、既有截图/无障碍页面清单；登录 helper 支持 generate 回跳而不一律断言 overview。
- [ ] 重跑新增 tests + `node --test frontend/tests/*.test.mjs`，确认通过。

### Task 4：图库详情联动

**Consumes:** `A.generation.addGalleryImage(item)`、`A.generation.isBusy()`、`A.navigate("generate")` 和当前图库详情 item。
**Produces:** “复制提示词”旁的“作为参考图”操作，追加成功才关闭弹窗并跳转。

- [ ] 写失败 tests：DOM 按钮顺序准确；点击捕获当前图片快照，不因异步期间浏览上一/下一张而引用错误图片；追加而非覆盖参考图，不覆盖 prompt/model/n/size；重复点击去重；读取失败/超限不关闭弹窗、不跳转、不污染列表；生图中按钮禁用或明确阻止。新增 dialog E2E 使用具体 accessible name/data-role 定位，不让既有通用 `getByRole('dialog')` 因多个隐藏对话框产生歧义，保留 `contracts.spec.ts` 的图库原图 fallback 断言。
- [ ] 运行对应 `generation.test.mjs` 和后续 Task 5 的 `generation.spec.ts` 图库联动场景，确认新行为失败；纯逻辑联动测试保留在 Node test，实际原弹窗通过 browser test 覆盖。
- [ ] 修改 `GALLERY_DIALOGS` 和 `GALLERY_SCRIPT`：捕获 item 后调用管理器，等待成功再关闭并 `A.navigate`；失败 A.toast，恢复按钮；图库列表选择 dialog 复用同一引用入口。图片原有复制、下载、删除、前后导航不改。
- [ ] 重跑新图库联动 tests 与现有 gallery/contract tests，确认通过。

### Task 5：浏览器验收、文档及构建产物

- [ ] 增加 Playwright 场景，使用已有 preview mock（不新建供应商 fixture）：登录→generate→纯文本生图→多图数字切换→图库日志归档；文件上传/拖放/剪贴板/URL→参考请求；图库详情转参考图→保持配置→auto 尺寸；失败后重试保留旧图。真 preview `n=2` 覆盖生成/归档；browser `page.route` 的延迟/错误响应覆盖等待与失败；mock 返回多于请求 n 的合法输出，数字按钮必须按实际 data 长度。参考图用受保护的图库 content bytes，不把 preview 的 loopback 上游 URL 当生产可用远程参考。
- [ ] 执行真实本地 mock 浏览器验收前调用 `run` skill；不把草图预览当作产品已验证，不使用付费上游。
- [ ] 添加 1440px/窄屏与深浅色、六项移动导航、键盘操作、图片等比可见、长数字列表不溢出、axe 页面/dialog 扫描；断言右侧不存在任务状态/下载/转参考图。浏览器核心断言使用以下固定语义：
  ```javascript
  await page.locator('[data-nav="generate"]').click();
  await expect(page.locator('[data-section="generate"]')).toHaveClass(/is-active/);
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.getByRole('button', { name: '生成中…', exact: true })).toBeDisabled();
  // mock 返回三张时，首张立即为大图，数字切换只改变当前 src；以 section 内 locator 限定作用域。
  await expect(previewImage).toHaveCSS('object-fit', 'contain');
  await imageNumber2.click();
  await expect(imageNumber2).toHaveAttribute('aria-pressed', 'true');
  await expect(resultArea.getByRole('button', { name: '作为参考图' })).toHaveCount(0);
  await expect(resultArea.getByRole('button', { name: '下载' })).toHaveCount(0);
  ```
- [ ] 运行 browser tests（现有 Playwright 配置和 mock preview），不得连接真实付费上游。
- [ ] `.gitignore` 已包含 `.superpowers/` 和构建产物，无需改动；README 说明控制台、同步请求刷新不恢复、结果在原图库/日志查询。实现时复制已批准计划到仓库计划路径，并同步设计说明的 Base64 本地预览细节。
- [ ] 先格式化源码再执行原静态资产构建，更新本地 `internal/webassets/dist/`；此目录已忽略，不 force-add、不手改哈希产物或恢复陈旧 assets。
- [ ] 运行全部 Go tests、Node tests、浏览器 tests、项目格式检查和 `go vet ./...`；本项目无 tsconfig 或 typecheck task，不为“类型检查”新增另一套构建配置。Windows TempDir cleanup 若单独抖动可用 `go test -p 1` 重跑，并报告首次失败。
- [ ] 查看 `git diff --check` 和 `git status --short`，保留用户原有未跟踪文件；独立 reviewer 检查最终 diff；不 commit/push。汇报真实执行的检查及结果。

## Verification

- Go targeted: `go test ./internal/httpapi -run 'TestAdminGeneration' -count=1`，然后 `go test ./... -count=1`；仅 Windows 清理抖动时串行重跑并说明。
- Node: `npm --prefix frontend test`；Build: `npm --prefix frontend run build`。
- Browser: `npm --prefix frontend ci`（依赖不存在时）后 `npm --prefix frontend run test:e2e -- generation.spec.ts gallery.spec.ts console.spec.ts contracts.spec.ts accessibility.spec.ts`；最终完整 suite：`npm --prefix frontend run test:e2e`。现有脚本自动构建资产和 E2E Go binary，启动 mock preview，不改 mock 供应商能力。首次若缺 Chrome/browser，按项目 Playwright 配置安装正确浏览器并如实记录。
- 手动 preview：`node frontend/scripts/build.mjs` 后 `go run ./cmd/agnes-proxy preview --port 8001`，本地登录 key `preview`；所有测试不连接真实上游。
- Go 使用 `gofmt -l internal cmd` 检查（只格式化本次改动文件）、`go vet ./...`。项目没有 Deno 格式/类型检查任务；TS/mjs 保持当前风格，不引入新的 tsconfig 或对全仓进行无关格式化。
- `git diff --check`、`git status --short`、独立整体审查；汇报所有真正运行的结果。
- 在本地 mock 浏览器逐项操作：文生图、参考生图、1/2/3 数字切换、图库详情引用并保留表单、失败后重试、日志/图库归档、浅/深色与窄屏导航。

## 执行方式

用户已选择 **当前会话直接实现**。批准计划后使用 `superpowers:executing-plans`，逐任务 TDD，最后一次独立整体审查。不使用多代理逐任务编排，不创建 worktree，不 commit/push。
