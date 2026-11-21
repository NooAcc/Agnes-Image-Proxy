# Agnes 参考图 auto 尺寸 — 设计

日期：2026-11-21
状态：待评审
关联：`docs/superpowers/specs/2026-11-20-agnes-image-proxy-design.md`

## 一、意图

OpenAI Images API 允许客户端省略 `size` 或传 `size: "auto"`，把尺寸决定权交给服务端。当前代理的
`auto` 只在本地推出比例、档位固定为 1K；未传 `size` 时还会使用设置里的 `defaultRatio`。对带参考图
的编辑请求，这会让输出尺寸与参考图无关。

本次改动的目标是：**当请求带参考图、且客户端没有显式指定 `size` 时，代理读取参考图的真实分辨率，
把它作为 `WIDTHxHEIGHT` 原样发给 Agnes；客户端没有显式给 `ratio` 时，payload 里不再出现 `ratio`，
让 Agnes 使用默认 1:1。** 显式给了 `size` 的请求完全不进入这条路径。

### 已实测的上游事实（2026-11-21）

| 请求 | 结果 |
| - | - |
| `size: "auto"` | HTTP 400：`size has invalid value "auto"` |
| `size: "900x1200"` | HTTP 200；输出图实际为 `864x1152` |
| `size: "900x1200"`, `ratio: "16:9"` | 输出仍为 `864x1152`，`ratio` 不生效 |
| `size: "2K"`，不传 `ratio` | 输出 `2048x2048`，Agnes 默认 1:1 |

结论：`auto` 不能透传，必须由代理换算；精确 `WIDTHxHEIGHT` 会被 Agnes 归一化到自己的档位/比例表，
因此**不能承诺输出就是参考图分辨率**。`ratio` 只在档位模式下有意义。

## 二、目标

- 带参考图 + 未传 `size` / `size: "auto"` → 用第一张参考图的真实宽高作为上游 `size`。
- 参考图来源：multipart 上传、`data:` URI、http(s) URL；URL 由代理安全下载读取。
- 客户端显式指定 `size` → 不读取、不下载参考图。
- 移除代理的 `defaultRatio` 设置；未显式给 `ratio` 时不发送该字段。
- 响应、请求日志、图片时间线记录生成图片的**实际尺寸**。
- URL 参考图无法读取时返回 400，而不是静默退回默认尺寸。
- 同步更新 README、设计文档和相关测试。

## 三、非目标与反目标

非目标：

- 不向上游发送 `size: "auto"`；上游不支持。
- 不改变显式 `WxH` 的现有处理：仍折算成最近的档位 + 比例后发送。
- 不改变 `n` 扇出、部分成功语义、模型目录、归档上限、管理 API 结构。
- 不做旧版本数据迁移或兼容层。
- 本次只交付 spec 与 plan，不写实现代码。

反目标：

- 参考图读不到时静默退回 `1K + 1:1`（旧行为）；这会让“auto 依据参考图”变得不可预测。
- 为显式指定了 `size` 的请求抓取参考图。
- 保留隐藏的默认 `ratio`。
- 因为输出尺寸探测失败而让客户端请求失败；输出图已经生成，探测失败只能降级并告警。

## 四、行为规格

### 4.1 触发条件

一条请求进入“参考图 auto 尺寸”路径，当且仅当：

1. `size` 未传、为空字符串、或大小写不敏感地等于 `"auto"`；并且
2. 请求中至少有一张参考图。

参考图来源与现有解析顺序一致：

- JSON：顶层 `image` → 顶层 `images` → `extra_body.image`。
- multipart：`image` / `image[]` / `images` 字段中的文件（转成 Data URI 后在前）→ 同名字段中的 URL。

只使用**第一张**参考图。第一张读不到就报错，不尝试后续图片。

其余情况保持现状：

- `size` 是 `1K`–`4K` 或任意 `WxH` → 完全跳过参考图读取和下载。
- 没有参考图 → 使用 `settings.defaultSize`，`ratio` 只有显式传入才发送。
- `size` / `ratio` 非法 → 现有 400 行为不变。

显式 `size: "auto"` 与未传 `size` 走同一逻辑。

### 4.2 参考图尺寸获取

按第一张参考图的形态选择读取方式：

| 形态 | 方式 |
| - | - |
| multipart 上传文件 | 字节已在内存中，直接用 `readImageDimensions` 读头 |
| `data:image/...;base64,...` | Base64 解码后读头 |
| `http(s)` URL | 代理发起受控 GET，只读取图片头 |
| 其他协议 | 现有校验直接 400 |

URL 读取规则：

- 允许 `http` 与 `https`；必须是公网主机。
- 拒绝：带用户名/密码的 URL、`localhost`、回环、私网 IPv4（10/8、172.16/12、192.168/16、
  127/8、169.254/16、100.64/10）、IPv6 回环/ULA/链路本地。
- `redirect: "manual"`，最多跟随 2 次；每次重定向目标重新做同样的 URL 校验。
- 单次请求超时 10 秒；最多读取 1 MiB；读到尺寸就立即取消读取。
- 非 2xx、网络错误、超时、重定向失败、内容不是 PNG/JPEG/WebP、或无法解析出尺寸 → 400。
- 只读图片头，不保存参考图，也不改变发给 Agnes 的参考图 URL。

multipart 与 Data URI 读不到尺寸时同样返回 400，保持一致。

### 4.3 尺寸解析

`ResolvedSize` 扩展为两种模式：

| 模式 | 何时使用 | tier | ratio（发上游） | pixel（预期原生输出） | 额外字段 |
| - | - | - | - | - | - |
| `exact` | 参考图 auto | 由参考图面积取最近档位 | 客户端显式 `ratio`，否则 `null` | 由最近档位 + 参考图推得比例决定 | `requestedPixel = 参考图宽高` |
| `tier` | 无参考图的 auto、显式档位、显式 `WxH` | 显式档位或默认档位 | 显式 `ratio`；显式 `WxH` 时可用推算比例 | `BASE_SIZES[ratio ?? "1:1"] × tier 倍率` | 无 |

规则：

- 档位按面积对数距离取最近；比例按宽高比对数距离取最近（沿用现有实现）。
- `exact` 模式下，`ratio` 字段只代表“要不要发”，不参与预期输出尺寸的计算；实测上游在精确尺寸
  存在时会忽略 `ratio`。
- 显式档位但不传 `ratio` 时，`ratio` 为 `null`，不再补 `1:1`。
- 显式 `WxH` 保持现有行为：折算成 `tier` + 比例；显式 `ratio` 优先，否则用像素推算比例。
- 非法 `size` / `ratio` 继续抛 400。

### 4.4 上游 payload

- `exact`：`size = "<参考图宽>x<参考图高>"`；`ratio` 仅在客户端显式提供时写入。
- `tier`：`size = "<档位>"`；`ratio` 仅在非 `null` 时写入；不再发送默认 `1:1`。
- 参考图、`response_format`、`return_base64`、`extra_body` 的处理不变。
- `n` 仍不发给上游。
- `X-Agnes-Resolved-Size` 记录实际请求表达式：
  - `exact`：`900x1200`
  - `tier` + ratio：`1K 16:9`
  - `tier` 无 ratio：`2K`

### 4.5 移除默认 ratio

- 从 `AppSettings`、`DEFAULT_SETTINGS`、`validateSettings`、设置页、README 和测试中移除
  `defaultRatio`。
- 数据库 `settings` 表中的旧 `defaultRatio` 行不再被读取；不做迁移、不写兼容代码。
- `ProtocolDefaults` 只保留 `defaultSize` 与 `defaultResponseFormat`。
- 探针、smoke 等内部请求可以显式写 `ratio: "1:1"`，那是请求自己的参数，不是代理默认值。

### 4.6 实际输出尺寸

每张成功返回给客户端的输出图都要测量实际宽高：

- `b64_json`：Base64 解码后 `readImageDimensions`。
- `url`：对 Agnes 返回的输出 URL 发起受控 GET，只读图片头。沿用 10 秒 / 1 MiB / 最多 2 次重定向的
  限制；输出 URL 只允许 `https` 与公网主机。
- 测量在写日志和返回响应之前完成；`n` 张图并行测量。
- 测量失败不改变客户端响应，只降级：
  - 响应体 `size` 用预期原生尺寸。
  - 日志的尺寸记 `null`（控制台显示 `—`）。
  - 相册仍以归档字节为准；若归档也没有字节，则用预期原生尺寸。

## 五、响应、日志与相册

### 5.1 响应

- 响应体 `size` = 第一张成功输出图的**实际** `WxH`；测量失败时用预期原生尺寸。
- 测量失败时在 `X-Agnes-Warnings` 追加 `size-measure-failed`。
- `data` 项结构不变，不新增每张图尺寸字段。
- `X-Agnes-Requested/Succeeded/Failed/Failure-Statuses`、部分成功语义不变。

### 5.2 请求日志

> 2026-11-21 后续：日志字段已由 `2026-11-21-p1-p2-hardening-design.md` 6.2 调整：
> `request_log.size` 拆为 `size_request` + `size_actual`，并新增 `stage`/`error_code`/逐 Key
> `attempts`；解析失败也会以 `stage=parse` 记录。尺寸语义本身不变。

- `request_log.size` = 成功输出图的实际尺寸：
  - 所有图尺寸相同：`864x1152`。
  - 多张图尺寸不同：去重后按出现顺序用逗号连接，如 `864x1152,1024x1024`。
  - 有成功图但全部测量失败：`null`。
  - 成功数为 0：记录本次请求表达式（`900x1200` / `1K 16:9` / `2K`）。
- 不新增列，不改变日志表结构。
- 参考图读取失败发生在解析阶段，不写请求日志（与现有解析失败行为一致）。

### 5.3 图片时间线

- `gallery.size` = 归档图片字节的实际 `WxH`。
- 归档下载失败（`archived=0`）时保留预期原生尺寸与 `source_url`。
- `gallery.tier` / `gallery.ratio` 存解析后的档位与**推算比例**，用于展示与筛选，不代表实际输出比例。
- 时间线卡片、灯箱、下载、删除、清空行为不变。

## 六、安全

- 本次新增了“代理请求客户端提供的 URL”的能力，旧文档中“代理永不请求客户端 URL”的承诺作废。
- 参考图下载与输出图测量共用一套受控下载逻辑；参考图允许 `http`/`https`，输出图只允许 `https`。
- 只读图片头；上限 1 MiB、10 秒、2 次重定向；每次重定向重新校验目标。
- 拒绝私网/回环/链路本地/带凭据的 URL；不跟随代理环境变量。
- 与现有归档下载一样，不额外实现 DNS rebinding 防护；这是已知边界，文档中明确说明。
- 参考图读取失败返回 400，不把网络错误细节、内部地址或响应体透给客户端。
- 控制台 CSP、鉴权、Key 掩码等其余安全约束不变。

## 七、破坏性变更

允许破坏性变更，不做兼容：

- `auto` / 未传 `size` + 参考图的 payload 从 `tier + ratio` 变为 `WIDTHxHEIGHT`；输出尺寸可能变化。
- URL 参考图从“不抓取、退回 1K/1:1”变为“抓取、失败即 400”。
- 设置项 `defaultRatio` 删除；依赖代理默认比例的客户端将得到 Agnes 默认 1:1。
- 响应 `size`、日志 `size`、相册 `size` 的语义从“请求/预期尺寸”改为“实际输出尺寸”。
- 旧的 `settings.defaultRatio` 行忽略即可，不迁移、不清理也可。

## 八、涉及文件

预计修改：

- `lib/limits.ts`：参考图/输出图读头超时、字节上限、重定向上限。
- `lib/remote-image.ts`（新增）：公网 URL 校验、受控读头、尺寸解析。
- `lib/size.ts`：`exact` / `tier` 模式，`ratio` 可空，移除默认比例。
- `lib/settings.ts`：移除 `defaultRatio`。
- `lib/protocol.ts`：解析改为可等待参考图读取；参考图选择、触发条件、payload。
- `lib/app.ts`：等待解析、测量输出图、写日志与响应尺寸、注入 `fetchImpl` 便于测试。
- `lib/archive.ts`：从归档字节读取实际尺寸写入 gallery。
- `web/sections/settings.ts`：移除默认比例表单字段。
- `README.md`、`docs/superpowers/specs/2026-11-20-agnes-image-proxy-design.md`：更新尺寸、设置与安全描述。
- 对应测试文件。

不需要修改表结构；`request_log.size` 与 `gallery.size` 已经是 TEXT，可存实际尺寸。

## 九、测试策略

全部离线，使用 fake `fetch`：

- 尺寸解析：`exact` 模式、`tier` 无 ratio、显式 `WxH`、非法值。
- 协议：未传 size + Data URI 参考图 → exact payload；显式 size 时 fake fetch 不被调用；
  显式 ratio 时写入 payload；无参考图 → 默认档位且无 ratio。
- 参考图 URL：PNG/JPEG/WebP、重定向、http 允许、https、私网/回环拒绝、超时、超限、非图片 → 400。
- 输出测量：b64 实际尺寸、URL 读头实际尺寸、测量失败降级与警告、多图混合尺寸。
- 日志：实际尺寸、混合尺寸、null、失败请求的请求表达式。
- 相册：归档字节实际尺寸；`archived=0` 回退预期尺寸。
- 设置：`defaultRatio` 不再出现；旧行被忽略。
- Web：设置页不再渲染默认比例字段。
- 最终运行 `deno task fmt:check && deno task lint && deno task check && deno task test`。

## 十、我做出的决定

1. **URL 参考图失败返回 400**，不退回默认尺寸。
2. **只取第一张参考图**，不逐张尝试。
3. **输出图 URL 的实际尺寸在响应前读取图片头**，而不是先返回再异步补日志；代价是每个 URL 输出
   多一次小请求（几百毫秒级）。
4. **测量失败不失败请求**：响应退回预期尺寸并加 `size-measure-failed` 警告。
5. **显式 `size` 的 `WxH` 仍折算成档位 + 比例**，不把用户给的 `WxH` 原样透传；只有参考图 auto
   路径透传 `WIDTHxHEIGHT`。
6. **不新增数据库列**，复用 `request_log.size` 与 `gallery.size`。
7. **不做旧数据迁移与兼容层**；删除 `defaultRatio` 后旧行自然忽略。
8. **精确尺寸 + 显式 ratio 两者都发**，但文档明确说明 Agnes 在精确尺寸存在时会忽略 ratio。
