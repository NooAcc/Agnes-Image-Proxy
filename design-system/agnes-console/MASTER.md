# Agnes Console 设计系统（已验证）

本文件记录已实施并验证的主题 token、组件规则与对比度结果。它不复制
ui-ux-pro-max 的原始查询内容，只保存本产品采用的决策。

## 方向

- 中文运维/图片管理控制台，data-dense dashboard，信息密集但克制。
- 中性底色 + 蓝色主操作；成功/警告/错误使用独立语义色。
- 分类（图片 NSFW tag）与状态（成功/失败/待处理）分别使用独立语义，
  且始终同时用文字与图标表达，不依赖颜色单独传递信息。

## Token 分层

1. **primitive**：`--primitive-*` 原始色阶与字号，仅主题文件使用。
2. **semantic**：`--semantic-*` 背景、表面、文字、主色、语义状态、焦点、遮罩。
   组件只能消费这一层。
3. **component**：`--component-radius`（0.5rem）、`--component-target`（2.75rem）。

`frontend/src/styles/tokens.css` 是唯一颜色来源；组件不硬编码色值。
Tailwind 通过 `@theme inline` 将这些变量映射为 `bg-surface`、`text-muted-foreground`
等工具类。

## 字体与尺寸

- 中文优先系统字体栈：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`；不加载 CDN 字体。
- 基础字号 16px，行高 1.5；次要元数据 12px（`text-xs`）。
- ID/尺寸/计数使用 `font-variant-numeric: tabular-nums`（数据页实施时应用）。
- 图标统一 Lucide SVG；装饰图标 `aria-hidden="true"`，图标按钮必须有可访问名称。

## 主题

- 首次跟随 `prefers-color-scheme`，可手动选择 浅色/深色/跟随系统，选择保存在
  `localStorage["agnes-console-theme"]`。
- 切换通过 `<html class="dark">` 与 `style.colorScheme` 同步。

## 对比度（WCAG 2.1 计算值）

| 组合 | 比率 | 要求 | 结果 |
|---|---:|---|---|
| 浅色 正文 `#0f172a` / 背景 `#f8fafc` | 17.06 | ≥4.5 | 通过 |
| 浅色 正文 / 表面 `#ffffff` | 17.85 | ≥4.5 | 通过 |
| 浅色 次要文字 `#475569` / 表面 | 7.58 | ≥4.5 | 通过 |
| 浅色 次要文字 / 背景 | 7.24 | ≥4.5 | 通过 |
| 浅色 白字 / 主色 `#2563eb` | 5.17 | ≥4.5 | 通过 |
| 浅色 成功 `#15803d` / 表面 | 5.02 | ≥4.5 | 通过 |
| 浅色 警告 `#b45309` / 表面 | 5.02 | ≥4.5 | 通过 |
| 浅色 错误 `#b91c1c` / 表面 | 6.47 | ≥4.5 | 通过 |
| 浅色 控件边框 `#64748b` / 表面 | 4.76 | ≥3 | 通过 |
| 浅色 焦点环 `#1d4ed8` / 表面 | 6.70 | ≥3 | 通过 |
| 深色 正文 `#f1f5f9` / 表面 `#0f172a` | 16.30 | ≥4.5 | 通过 |
| 深色 正文 / 背景 `#020617` | 18.41 | ≥4.5 | 通过 |
| 深色 次要文字 `#94a3b8` / 表面 | 6.96 | ≥4.5 | 通过 |
| 深色 白字 / 主色 | 5.17 | ≥4.5 | 通过 |
| 深色 成功 `#4ade80` / 表面 | 10.25 | ≥4.5 | 通过 |
| 深色 警告 `#fbbf24` / 表面 | 10.69 | ≥4.5 | 通过 |
| 深色 错误 `#f87171` / 表面 | 6.45 | ≥4.5 | 通过 |
| 深色 控件边框 `#94a3b8` / 表面 | 6.96 | ≥3 | 通过 |
| 深色 主色 `#2563eb` / 背景 | 3.90 | ≥3（按钮边界） | 通过 |

装饰性分隔线 `--semantic-border`（浅色 1.48、深色 1.72）不承载交互信息，
不作为控件可识别边界；表单控件使用 `--semantic-control`。后续若用它标识
状态或控件边界，必须重新验证 ≥3。

## 交互规则

- 交互目标最小 44×44px（`min-h-11`、`size-11`），相邻目标间距 ≥8px。
- 焦点环 2px、偏移 2px，键盘焦点不被 sticky 元素遮挡（当前头部非 sticky）。
- 状态反馈过渡 150ms；`prefers-reduced-motion: reduce` 下动画/过渡近似关闭。
- 移动端导航使用 Radix Sheet（焦点陷阱、Escape、焦点恢复由组件负责）；
  桌面使用常驻侧栏。
- 数据表在窄屏使用容器横向滚动，不让页面整体溢出。

## 组件

- 基于 shadcn/ui 模式与 Radix：Button、Input、Label、Field、Dialog、AlertDialog、
  Sheet、Select、Table、Badge、Skeleton。
- 表单字段有可见 label、说明与字段级错误（`role="alert"`）；破坏性操作使用
  AlertDialog 明确对象与后果。

## 图表系列色

- 总览使用两条单系列折线（请求、图片），各自独立 Y 轴，不叠双轴、不用饼图
  或仪表；网格与坐标文字使用中性语义 token。
- 系列色：请求 `--semantic-primary`，图片 `--semantic-success`。折线 2px，
  数据点带 44px 命中区域，键盘聚焦与鼠标悬停都会更新数值提示；表格视图
  提供完全相同的逐日数值。
- 2026-11-24：`frontend/scripts/check-colors.mjs` 对实际表面校验（非文本图形
  阈值 ≥3:1）全部 PASS：浅色请求 5.17、浅色图片 5.02、深色请求 3.45、
  深色图片 10.25。

## 验收记录

- 2026-11-24：主题/导航/可访问名称组件测试通过（Vitest + Testing Library）。
- 对比度数值由 WCAG 相对亮度公式计算（sRGB，未做四舍五入前的完整精度）。
- 2026-11-24：Playwright 生产构建实测（系统 Chrome）：13 项 E2E 通过，覆盖登录、五页面、
  深链接刷新、表单校验、账号 CRUD/导入/探测、日志分类与详情、模拟生成/编辑、下载响应、
  删除取消零删除、原图快速切换、补齐状态与隐藏标签页暂停轮询、会话撤销重登、移动端
  Sheet 焦点恢复、200% 缩放、reduced-motion。axe 在登录页与五个主页面均为
  0 serious/critical；截图 375/768/1024/1440px × 浅/深色共 32 张（另有图表 tooltip 与原图
  Dialog）输出到 `frontend/test-results/screenshots/`。
- 2026-11-24：人工检查截图后修正：图表 SVG 改用 `role="group"`（避免 `role="img"` 嵌套
  可聚焦数据点）、图库缩略图按钮使用 `sr-only` 名称、窄屏表格设置最小宽度并在容器内
  横向滚动（账号 760px、模型用量 560px、日志尝试 520px）。
