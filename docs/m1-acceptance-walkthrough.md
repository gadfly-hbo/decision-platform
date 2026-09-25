# M1 验收走查记录（任务 5 交付物）

走查时间：2026-09-25。验证环境：dev server (vite) + 真实浏览器（IAB，390×844 与 1280×900）+ Playwright 截图。

## 1. 30 秒标准走查（产品级验收）

打开页面首屏（1280×900）即可见：标题、产品句、数据窗口 → 4 条结论按 高/中/中/低 排序 → 最高严重度结论默认展开，推导链路（4 步编号）、核心指标折线图（含止损线标线）、归因明细表、建议行动一次到位。**形态满足"30 秒内知道今天要拍板什么"**；真实信噪比验证属 M2（PRD Further Notes 已声明）。

## 2. Xanthil token 对照清单

| 规范项 | 落点 | 结果 |
| --- | --- | --- |
| 三级表面 bg/surface/surface-2 | 页面底/卡片/表头与次级区域 | ✅ |
| 边框两级 border/border-strong | 卡片描边/表格上边线/虚线占位 | ✅ |
| 文本三级 text/text-2/text-3 | 标题/摘要/窗口与口径说明 | ✅ |
| 青色 accent 仅用于主操作与选中态 | 筛选 chip 选中态、建议步骤 chip、焦点环；结论标题不加色 | ✅ |
| 语义色成对（深字+soft 底+line 描边） | 严重度 chip（fail/warn/queue 系）、行动状态（queue/ok/中性） | ✅ |
| 状态色+文字双通道 | chip 均带文字（高/中/低、待定/采纳/驳回）；正负贡献带 +/− 符号与 ok/fail 色 | ✅ |
| 排版档位 | page-title 22/600（每页一个 h1）、view-title 17、card-title 13.5、body 13、meta 10.5；数字 tabular-nums；步骤编号 mono | ✅ |
| 圆角/间距 | 卡片 10px、按钮输入 chip 容器 6px、状态 chip pill；卡内边距 14、卡间距 14 | ✅ |
| 不用阴影表达层级 | 全站无阴影（仅边框与背景） | ✅ |
| 空状态虚线框 | 结论区空状态、汇总区空过滤态 | ✅ |
| 不引入组件库 | 全部自定义控件 | ✅ |
| 不适用项 | 三栏工作台外壳/命令面板/状态栏（PRD Out of Scope，产品化阶段） | ➖ |

## 3. PRD User Stories 对照（16/16）

| # | 故事 | 落点 |
| --- | --- | --- |
| 1 | 结论列表按严重度排序 | App 排序 + 测试「结论区按严重度排序」 |
| 2 | 一句话结论扫读 | ConclusionCard 标题+摘要 |
| 3 | 严重度区分 | 高/中/低 chip |
| 4 | 展开看推导过程 | DerivationChain 四步 |
| 5 | 指标趋势+基准线 | MetricChart markLine |
| 6 | 归因明细 | BreakdownTable |
| 7 | 建议行动+预期影响 | ActionItem |
| 8 | 行动状态标记 | ActionItem 状态组 + ActionSummary 联动 |
| 9 | 数据窗口与更新时间 | 概览头 + 卡片 meta |
| 10 | 单一数据模块 | src/data（App 仅消费类型） |
| 11 | 指标集中定义 | MetricDef + formatMetricValue |
| 12 | 双域泛化 | docs/domain-mapping-walkthrough.md |
| 13 | 顶部说明句 | 概览头 lede |
| 14 | 空状态 | 结论区空状态 + 测试 |
| 15 | 色彩+文字双通道/统一设计语言 | tokens.css + 第 2 节清单 |
| 16 | 窄屏可用 | ≤900px 媒体查询 + 第 4 节实测 |

## 4. 响应式实测记录（真实浏览器）

- 修复前（390px）：页面横向溢出 874 > 390 —— grid 项 `min-width: auto` 被 nowrap 表格撑宽，滚动容器失效。
- 修复：`.conclusion-list > li { min-width: 0 }`（src/App.css）。
- 修复后（390px）：`pageHasHorizontalOverflow: false`（390 = 390），表格容器 `overflow-x: auto` 生效，内容无裁切。页面完整性：4 张结论卡 + 行动汇总（全部 4/待定 4/采纳 0/驳回 0）均在。
- 桌面 1280×900：首屏/全页截图核对通过（标题、四块证据、图表渲染、配色无异常）。
- 图表 resize：由 MetricChart.test.tsx 行为测试覆盖（挂载 init+setOption → 容器尺寸变化触发 resize → 卸载 dispose；echarts 渲染引擎在系统边界 mock）——REVIEW cycle 1 发现 2 的补证。

## 5. 遗留与已知项

- 构建警告：echarts 使 chunk > 500KB（gzip 后可接受）；产品化时可按需 code-split，M1 不处理。
- 图表 tooltip 为 ECharts 默认样式，未做 Xanthil 定制（视觉走查未发现冲突，留产品化阶段）。
- 归因表「变化」列的比较基数未在表头声明（REVIEW cycle 4 MINOR）：M2 打磨项——需 BreakdownTable 支持表级基数说明并重算演示数据该列。
- 真实信噪比、真实数据源、给谁用三项未决（红队 KA1/KA2），为 M2 前置门。
