# PRD：decision-platform M5 — 报告驱动行动闭环看板

合成自 `.flow/proposal.md`（最高优先）+ 红队报告 + 代码库调查。本文件阐述并补细，不推翻 proposal 决策。

## Problem Statement

经营者每周收到的是**已成文的数据分析报告**，而不是可计算的数据表。当前 decision-platform 只吃会员周报 CSV（解析→规则→结论），与真实工作流脱节：报告里的结论建议需要人重新读一遍、口头讨论、事后无人追踪是否执行、执行后效果无回录。决策建议、行动确认、执行反馈散落在聊天记录里，没有闭环。

## Solution

把看板重构为**报告驱动的行动闭环**（对齐 pi-xanthil Actions 模式）：

1. 报告（md/txt）放入 `data/raw/` 即被识别；
2. LLM（pi-agent-runtime 0.4.1 `runWorker`）从报告抽取**决策建议行动项**——每项带结构化证据（报告原文逐字引用、四级证据等级、推导过程）与由证据派生的置信度；
3. 人在看板或**飞书审批卡片**上确认（采纳/驳回）；
4. 采纳项拆解为带负责人/截止日的执行任务；
5. 执行后回录反馈（结果/指标变化/复盘/评分），形成可追溯的行动资产。

CSV 解析、规则引擎、异动检测管线退役。

## User Stories

1. As a 经营者, I want 把分析报告放进一个目录就能自动生成决策建议行动项, so that 不用手动读报告抄行动。
2. As a 经营者, I want 每条行动项展示它的报告依据（原文引用、证据等级、推导过程）, so that 30 秒内判断这条建议靠不靠谱。
3. As a 经营者, I want 每条行动项有由证据派生的置信度而非 LLM 自评, so that 排序可信。
4. As a 经营者, I want 在看板上采纳或驳回建议, so that 决策有记录。
5. As a 审批人, I want 在飞书收到审批卡片直接点采纳/驳回, so that 不用开电脑也能拍板。
6. As a 审批人, I want 卡片上看到结论、证据摘要与置信度, so that 移动端也有足够信息拍板。
7. As a 审批人, I want 重复点击卡片幂等、旧报告卡片点不了, so that 不会误操作。
8. As a 店长/执行人, I want 被采纳的行动项拆成带负责人和截止日的任务, so that 知道谁在什么时候做什么。
9. As a 店长/执行人, I want 更新任务状态（待办/进行/完成）, so that 进度可见。
10. As a 经营者, I want 执行完后回录结果、指标变化、复盘和评分, so that 行动效果沉淀。
11. As a 经营者, I want 按状态（建议/已采纳/已驳回）、证据等级、优先级过滤行动项, so that 快速聚焦。
12. As a 经营者, I want 看板按报告期次组织行动项并保留历史, so that 每周的报告决策可回溯。
13. As a 经营者, I want 一份报告只抽取一次（幂等）, so that 不重复推送打扰。
14. As a 经营者, I want 新报告到达后自动推送（飞书卡片优先，未配置时群机器人文本摘要）, so that 不需要任何人先打开看板。
15. As a 经营者, I want LLM 不可用/无报告时看板有明确状态（而非静默空白）, so that 知道发生了什么。
16. As a 经营者, I want 抽取失败时能手动重试, so that 临时故障不丢一份报告。
17. As a 开发者, I want 每次模型调用有任务账本与审计留痕, so that 消费可核查、符合 SDK 接入标准。
18. As a 开发者, I want 抽取管线可离线测试（合成 transport 回放）, so that 不依赖真实供应商跑测试。

## Implementation Decisions

**后端管线（替换）**
- 新增 SDK 适配层（业务代码唯一触达 pi-agent-runtime 的位置）：显式模型链（MiniMax-M3 主 + 小米 mimo 备，密钥从 `~/.pi/agent/auth.json` 或环境变量读，缺密钥时降级不阻塞启动）、JSONL 审计 sink（append 即持久确认，失败上抛关闭准入）、文件持久任务账本 BudgetStore（同任务唯一 lease、配置签名、重启不清账、累计不封顶策略）、本地单用户授权策略（model/publish 放行，无工具）。
- 抽取任务 = `runWorker`：无工具单次模型调用 + 宿主 validator（对齐 AGENT-RUNTIME P2：固定结构化变换用 Worker）。validator 复刻 pi-xanthil 的归一化：JSON 数组提取与宽松修复、scene/lifecycle/priority/effort 枚举校验、evidence 结构化（facts+quote、四级 level、reasoning）、confidence 由证据派生（base(level)+quote 加成、无 facts 封顶 0.5）、占位文本拒绝。
- 抽取 prompt 对齐 pi-xanthil Actions：行动方案提取引擎角色、严格 JSON、quote 必须逐字、报告无数据则降级"经验假设"、无行动项返回空数组；输入前裁剪与脱图（图片引用替换为占位）。
- 报告识别：`data/raw/` 下 `.md`/`.txt`（UTF-8）；报告身份 = 文件名（slug 化）；已处理报告记录在库，调度器只对**新报告**触发抽取（幂等：每报告一次，失败可手动重试）。
- 退役：CSV 解析、规则引擎、指标口径、异动结论装配、跨周对照（review.ts）。`data/raw/` 中旧 CSV 不再读取。

**存储（替换）**
- SQLite（node:sqlite，零新依赖）单文件库（`data/board.db`），四张表对齐 pi-xanthil Actions schema 并扩展：`reports`（身份、文件名、导入时间、状态）、`action_items`（status: suggested/adopted/dismissed、title/rationale/scene/lifecycle/expectedImpact/priority/effort/confidence、evidence_json/evidence_level、report 关联、审批留痕 decidedBy/decidedAt/decidedVia）、`action_tasks`（owner/dueDate/status: todo-doing-done/priority/note，外键级联）、`action_feedback`（adopted/outcome/metricDelta/review/score，一任务一条）。旧 `data/actions.json` 不迁移（产品形态变更，旧文件保留在磁盘归档）。

**API（node:http 路由表保持手写风格）**
- `GET /api/dashboard`：概览（最新报告、行动项统计、通知状态）+ 全量行动项（含任务与反馈）。
- `POST /api/reports/extract`：对指定（或最新未处理）报告手动触发抽取；`GET /api/reports`：报告列表与处理状态。
- `POST /api/actions` / `PATCH /api/actions/:id`（确认状态变更）/ `DELETE /api/actions/:id`。
- `GET/POST /api/actions/:id/tasks`、`PATCH /api/tasks/:id`。
- `POST /api/tasks/:id/feedback`、`GET /api/tasks/:id/feedback`。
- `POST /api/notify/push`（手动重推）、`POST /api/notify/test` 保留语义。
- `GET /api/health` 保留；新增模型链可用性信息。

**飞书审批（保留并适配）**
- 长连接桥接、卡片直审、幂等、留痕、先到先得、过期卡片拒绝——机制原样保留（im.ts / im-feishu.ts）。
- 审批对象从"结论"改为"行动项"：卡片正文 = 行动项 + 证据摘要（top fact 引用 + 证据等级 + 置信度）+ 预期效果；按钮 采纳（→adopted）/ 驳回（→dismissed）。
- 推送策略：每份新报告抽取后，**高优先级或高置信（数据支撑级）行动项逐条推卡片**，其余进文本摘要（防审批疲劳——红队 #4 优化）。
- 未配置飞书时回落群机器人 webhook 文本摘要（M3 通道保留）。

**前端（替换内容区，保留骨架与视觉基线）**
- 单页三段式改为「报告概览头 + 行动项列表 + 任务/反馈」：
  - 行动项卡片：标题、优先级/effort、置信度、scene/lifecycle 标签、证据可展开（四级色标：数据支撑=绿/多源佐证=蓝/逻辑推断=琥珀/经验假设=灰，quote 块引用原文）、预期效果、采纳/驳回操作。
  - 采纳项展开任务列表（新增/编辑 owner、截止日、状态）与反馈回录表单（结果、指标变化、复盘、评分）。
  - 过滤器：状态、证据等级、优先级；标注"证据等级由提取模型自评，未做真实数据重验证"。
- 演示回退保留（无报告/无密钥时 isDemo 标注演示行动项）。ECharts 图表与多周趋势随 CSV 管线退役。
- 视觉沿用现有 Xanthil 基线（token/卡片/焦点环）。

**测试缝（seam）**
- 最高缝：`startServer(options)` 已有注入缝（dataDir 等注入）扩展为 dbPath/agentRunner 注入——服务测试全走 HTTP + 内存/临时库。
- SDK 缝：agent 层暴露 `runExtraction(report) → ActionItemDraft[]`，内部经 runtime.runWorker；测试用 `pi-agent-runtime/testing` 的 `createReplay` 合成 transport（离线、不调真实供应商），真实验证单独一次性有界执行。
- 解析/归一化（validate）纯函数直接单测。

## Testing Decisions

- 只测外部行为：HTTP 端点契约（含负向：非法 body、不存在 id、无报告、模型失败降级）、抽取归一化纯函数（枚举、证据降级、confidence 公式、quote 校验、宽松 JSON 修复）、调度幂等（同报告不重复抽取/推送）、飞书卡片映射（复用 im-feishu.test.ts 模式：channel 注入假对象）。
- 先例：`server/server.test.ts`（注入 options + 真实 HTTP 监听）、`server/im-feishu.test.ts`（channel 假对象）、vitest 全仓 `npm run verify`（tsc + vitest + build）。
- SDK 消费测试用合成回放 transport；真实 Provider 只在实现完成后一次有界真调（用户委托已含真实使用意图）。

## Out of Scope

- CSV/规则引擎/异动检测/多周趋势的任何保留或迁移。
- 黄金策式框架图生成、多分析模型批量抽取。
- 钉钉适配、多审批人（或签/会签）、公网部署与鉴权升级。
- pi-xanthil 报告产出的自动管道对接（报告仍人工放入目录；来源自动化另行立项）。
- 旧 data/actions.json 历史迁移。

## Further Notes

- 部署形态不变：Mac mini 单实例 launchd 常驻、局域网访问、`data/*.json`/`data/board.db` 不入库。
- runWorker 单次保护参数初值：输入裁剪 16k 字符、maxOutputTokens 8192、modelTimeoutMs 120s、controlTimeoutMs 30s（可调，不构成预算承诺）。
- 本 PRD 无 issue tracker，按 dev-flow 降级写 `.flow/prd.md`。

## PRD 对 proposal 的增量（auto 模式自批清单）

- 新增：SQLite 存储（node:sqlite）与四表 schema、报告身份=文件名、幂等抽取调度、卡片只推高优/高置信（防疲劳）、SDK 测试用合成回放、单次保护参数初值、演示回退保留、webhook 文本降级保留、旧 actions.json 不迁移。
- 未改变或删减任何 proposal 决策。

## GRILL 决议（2026-10-12，auto 模式自答，仅覆盖 proposal 留白）

### 第 1 轮

- **G1 报告文件名与日期**：不强制文件名含日期；报告身份 = 文件名 slug，展示排序按导入时间倒序；期次概念退化为"按报告组织"。（推荐采纳，理由：报告来源多样，强制日期约束收益低）
- **G2 前端组件处置**：ConclusionCard/DerivationChain/MetricChart/ContributionChart/BreakdownTable/ActionSummary 及 demo 数据全部重写为行动闭环组件（ActionItemCard/TaskList/FeedbackForm/演示行动项）；**echarts 依赖随之移除**（无用代码不留）。（推荐采纳）
- **G3 重抽语义**：`POST /api/reports/extract` 默认只处理"未成功抽取"的报告；`force:true` 重抽时，该报告下仍处 `suggested` 的行动项删除重建，`adopted/dismissed/有任务` 的保留。（推荐采纳，理由：保护已发生的决策与执行留痕）
- **G4 反馈 score**：1-5 整数，5=显著正向效果，3=无明显变化，1=显著负向。（推荐采纳）
- **G5 服务端文件处置**：`report/parseCsv`、`rules/`、`review.ts`、`actions.ts`(JSON 存储)、`dashboard.ts` 结论装配删除/重写；`notify.ts` 改造内容源（行动摘要）；`im.ts`/`im-feishu.ts` 机制保留、卡片构造适配行动项；`server/index.ts` 路由重排。测试文件同步重写。（推荐采纳）
- **G6 环境事实**：Node v24.21.0，node:sqlite DatabaseSync 可用；本机 ~/.pi/agent/auth.json 存在（真实验证可行）。无需决策，记录为已验证。

### 第 2 轮（第 1 轮决议引出的新问题）

- **G7 演示数据形态**：无报告时 isDemo 演示行动项 = 固定 3 条样例（各覆盖一种证据等级），标注"演示数据"；无密钥但有报告时显示明确错误状态（不冒充演示）。（推荐采纳，区分"无输入"与"能力故障"）
- **G8 notify-state 幂等键**：推送幂等键从"期次"改为"报告文件名 slug"，notify-state.json 结构不变、语义平移；手动重推端点保留"真正再发一轮"语义。（推荐采纳，复用已验证的幂等漏斗）
- **G9 多报告并存**：看板默认聚合展示全部报告的行动项（报告名分组/过滤），不做单报告切换页——行动项量级（每周 ≤10）不需要。（推荐采纳）

## UI-GATE 用户变更回灌（2026-10-12，第 1 轮，用户原话锚定）

> 1- 驳回建议，需要有窗口输入理由
> 2- 允许用户增加报告中提取的建议之外的其他建议
> 以上两步相当于是用户在 teach 智能体分析结论的准确性，也帮助沉淀有用的决策

### G10 驳回必填理由（弹窗输入）
- 看板驳回行动项：点击「驳回」→ 弹出理由窗口（textarea 必填，≥2 字；确认/取消）→ 落库 `dismissedReason` + 驳回时间/渠道。
- 飞书卡片驳回：保持单键直驳（移动端无输入成本），卡片渠道驳回 `dismissedReason` 记为「卡片驳回（未填理由）」，看板详情区提供**补填理由**入口（补充后覆盖）。
- 语义定位（用户原话）：驳回理由 = 对抽取准确性的 teach 信号，是决策资产的一部分，必须沉淀可查。

### G11 人工补充建议（报告外建议）
- 看板提供「补充建议」入口：表单（标题必填、依据/理由必填、scene/lifecycle/priority/effort 可选）→ 创建 `sourceKind=manual` 的行动项，`reportId` 可空（过滤器归入「人工补充」分组）。
- 人工项证据等级固定「经验假设」+ 依据文本入 evidence.reasoning，confidence 显示「人工」徽标（不参与派生公式）。
- 人工项与抽取项同权走 确认→任务→反馈 闭环（manual 创建即 `suggested`，仍需采纳确认）。

### G12 抽取校准注入（teach 回路，G10/G11 的兑现）
- 抽取 prompt 注入近期校准上下文：最近 ≤10 条驳回理由（原文）+ 最近 ≤10 条人工补充建议标题与依据，作为「用户已判定的误报方向」与「用户关注的额外方向」提示模型。
- 注入内容来自库内查询，不外传报告外新数据；无校准数据时不注入（prompt 形态不变）。

### API 增量
- `PATCH /api/actions/:id`：status→dismissed 时接受 `dismissedReason`（看板渠道必填校验；card 渠道默认值）；新增补填语义（仅 dismissed 项可补填）。
- `POST /api/actions`：`sourceKind: extracted|manual`（manual 走 G11 校验），`reportId` 可空。
- 表结构增量：`action_items` 增 `dismissed_reason`、`source_kind` 列；`report_id` 可空。

### G13 三栏工作台布局（参考 report-factory UI，用户 UI-GATE 追加变更 #3）
- 布局从单列居中改为三栏 shell：**左栏（固定窄栏）报告导航** + **主内容区（既定四区）** + **右栏（可开关抽屉）运行详情**。
- 左栏内容：报告列表（报告名、导入时间、抽取状态点：待抽取/抽取中/已抽取/失败），固定项「全部」与「人工补充」；点击 = 主区过滤器按报告聚焦（与 S6 过滤器联动，非路由）。删除报告不提供（报告是磁盘文件事实源）。
- 右栏「运行详情」（默认收起，顶栏按钮开关，参考 report-factory wb-drawer）：模型链状态（主备模型+密钥就绪 chip）、SDK 任务账本用量（模型调用次数、token 入/出、累计用时，来自 BudgetStore 快照）、抽取事件时间线（报告抽取开始/成功/失败+原因，来自审计/日志投影）。
- 窄屏（<1080px）侧栏折叠为横向条，主区优先——可访问性顺序：主内容在前，侧栏在后（DOM 顺序）。

### G14 布局变更对既有决议的平移
- G9 多报告聚合展示不变：默认「全部」，左栏是聚焦器不是切换页。
- 概览头 S1 的统计与通知 chip 保留在主区顶部；报告状态条 S1b 与左栏状态点同源（同一数据两处呈现，左栏精简、S1b 带操作按钮）。
- max-width 860px 单列约定废止，改三栏自适应；Xanthil token/焦点环/卡片基线不变。


## PRD 勘误（REVIEW 轮）

- 「API」节的 `GET /api/health` 保留未扩展：模型链可用性信息实际位于 `GET /api/dashboard` 响应的 `modelChain` 字段（主/备 + keyReady），前端 S-R 抽屉与 S9 错误条同源消费。
- `POST /api/actions` 仅创建人工补充项（sourceKind 恒为 manual、走 G11 校验）；`sourceKind: extracted|manual` 参数保留给读取侧语义，不由请求指定。
