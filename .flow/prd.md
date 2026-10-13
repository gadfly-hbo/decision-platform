# PRD：decision-platform M6 — 项目化看板

合成自 `.flow/proposal.md`（最高优先，含用户四点确认）+ 红队 + M5 现状代码。阐述并补细，不推翻 proposal 决策。

## Problem Statement

M5 的「报告放全局目录 → 自动出现在唯一看板」不符合真实组织方式：不同业务/主题的报告应各自成组，每组一个看板、一套行动闭环；且目录投放的入口不自然，报告应从项目内上传进入。

## Solution

引入**项目**作为根容器：新建项目 → 项目内上传报告（.md/.txt）→ 上传即触发 agent 抽取 → 项目看板呈现行动闭环（确认/任务/反馈全能力不变）。全局目录监听与全局调度退役；左栏改为项目导航；删项目 = 硬删（确认弹窗，连报告文件与库内数据）。存量数据清空起步。

## User Stories

1. As a 经营者, I want 新建/重命名/删除项目, so that 按业务线或主题组织看板。
2. As a 经营者, I want 在项目内上传 md/txt 报告, so that 报告进入正确的看板而不是全局混杂。
3. As a 经营者, I want 上传后自动触发 agent 抽取并看到抽取状态, so that 不需要手动再点一步。
4. As a 经营者, I want 左栏切换项目、看到每项目行动项计数与最近活动, so that 多项目一目了然。
5. As a 经营者, I want 删除项目时有确认弹窗明确告知报告文件一并删除, so that 不误删。
6. As a 经营者, I want 项目内报告列表带状态与重新生成按钮, so that 失败可重试、已抽可强制重抽。
7. As a 经营者, I want 本项目历史驳回理由与人工补充只校准本项目的后续抽取, so that teach 信号不串项目。
8. As a 审批人, I want 飞书推送摘要带项目名, so that 知道在批哪个项目的事。
9. As a 经营者, I want 无任何项目时有新建引导而非演示数据冒充, so that 首次使用不困惑。
10. As a 开发者, I want 项目作用域贯穿 API 与存储, so that 数据归属清晰、误操作不跨项目。

## Implementation Decisions

**存储（迁移 = 清空重建，非 ALTER）**
- 启动时检测旧库（无 projects 表即 M5 库）：按用户决策直接删除重建（`data/board.db` 删除后重建新 schema，无需迁移代码；实现为版本标记 schema_version）。
- `projects` 表：id（uuid）、title（必填唯一性不做强制）、purpose（可选）、created_at/updated_at；删除时事务内级联清 reports/action_items/tasks/feedback + 删除 `data/projects/<id>/` 目录。
- 既有四表加 `project_id`（reports 直挂；action_items 经 report 间接 + manual 项直挂 project_id）；外键级联沿用。
- 报告文件：`data/projects/<projectId>/reports/<原文件名>`；上传时 slug = 项目内文件名规范化，**同项目同名上传 = 覆盖文件并按 force 语义重抽**（G3 保护已决项）；不同项目同名互不影响。

**报告入口**
- `POST /api/projects/:id/reports`（multipart 或 JSON base64 内容——用 JSON base64 与现有无依赖风格一致）：filename + content；≤2MB、仅 .md/.txt；非法 400。写入文件 → 注册 pending → **立即异步触发抽取**（复用 runExtraction + 状态机；不阻塞上传响应）。
- 手动：`POST /api/projects/:id/reports/extract`（slug/force 语义同 M5 G3）。
- 全局 `data/raw/` 扫描、`scanReports(dataDir)` 全局注册、全局调度器 `startPushScheduler` 的目录扫描部分退役；调度器保留仅作「漏斗推送兜底 tick」或整体移除（GRILL 定：**移除调度器，推送在抽取完成处直接触发**——事件驱动，少一个常驻定时器）。

**API（项目作用域）**
- `POST /api/projects`、`GET /api/projects`（列表+统计）、`PATCH /api/projects/:id`（重命名/purpose）、`DELETE /api/projects/:id`（硬删+目录）。
- `GET /api/projects/:id/board`（= M5 BoardView 加 project 元信息）；旧 `GET /api/dashboard` 移除（前端唯一消费方一起换）。
- `GET /api/projects/:id/reports`；行动项/任务/反馈端点路径不变，服务端按 item 反查项目校验归属（跨项目 id 404）。
- `GET /api/health`、`/api/agent/*` 不变。

**推送**
- 抽取完成后（该项目报告 done 且有新行动项）触发推送：摘要 =「【项目名】+ M5 行动摘要」；高优卡片同 M5；幂等键 = `projectId:slug`；手动重推 `POST /api/notify/push` body 加 projectId（缺省最新活跃项目）。

**G12 项目级校准**
- `loadCalibrationContext(db)` 加 projectId 过滤：驳回理由与人工补充均限本项目。

**前端**
- S-L → 项目导航：顶部「＋ 新建项目」（inline 表单：名称必填/purpose 可选）、项目列表（名、行动项计数 chip、最近活动时间、删除 × 带确认弹窗——弹窗复用 scrim/dialog 基线，文案含「报告文件将一并删除」）、当前项目高亮；空态「尚无项目——新建一个开始。」。
- 主区：概览头显示项目名（+purpose）与该项目统计；报告条（S1b）升级：**「上传报告」按钮**（file input，多文件支持）+ 项目内报告列表（文件名/状态点/抽取中 spinner/失败↻/done 可两段式重新抽取）。
- 无项目空态：主区引导「左栏新建项目」；**演示态退役**（G7 演示数据删除——项目化后演示意义下降，首启引导替代；demo.ts 与相关测试删除）。
- 上传后轮询/刷新看板（抽取中→done 的状态可见；沿用 aria-live）。
- S2-S5 行动闭环、S-R 运行详情、驳回弹窗、飞书卡片全部不动（仅数据源带项目）。

**测试缝（沿用）**
- 最高缝 startServer(options) 注入：dbPath、agentRunner、projectsDir；HTTP 测试走真实监听。
- SDK 缝不变（runner 注入假实现）。

## Testing Decisions

- 项目 CRUD（含硬删级联+目录清理+确认语义在 API 层 = 无软删路径）、上传（大小/类型/同名覆盖+force 重抽保护）、抽取触发（上传即抽、失败可重试）、项目作用域隔离（A 项目 id 在 B 项目上下文 404）、G12 项目级过滤、推送摘要带项目名+幂等键、无项目空态、前端导航交互（切换/新建/删除确认弹窗/上传）。
- 先例沿用：server.test/reports.test/board-api.test 模式；SDK 离线回放不动。

## Out of Scope

- JuanerAI 对接（后续候选，不设占位 UI）。
- 项目归档/软删、项目级审批人配置、项目间数据共享/导出。
- 演示数据（随项目化退役）。

## PRD 对 proposal 的增量（auto 自批清单）

- 新增：报告文件项目目录布局与同名覆盖=force 语义、上传 2MB/类型限制、调度器整体移除改抽取完成处触发推送、旧 /api/dashboard 移除、演示态退役、schema_version 重建策略、跨项目 id 归属校验 404。
- 未改变或删减任何 proposal 决策。

## GRILL 决议（2026-10-13，auto 自答，覆盖 proposal 留白）

- **G1' 同名上传语义**：覆盖文件 + force 重抽（G3 保护已决项）——同名即"更新这份报告"的自然语义。
- **G2' 上传限制**：单文件 ≤2MB、仅 .md/.txt（大小写不限）、UTF-8 可读；超限/非法类型 400 带原因；多文件上传逐份处理、单份失败不影响其余（响应逐份结果）。
- **G3' 调度器**：整体移除 startPushScheduler——推送在抽取完成处事件驱动触发（漏斗函数复用）；launchd 常驻不受影响。
- **G4' 无项目空态**：主区引导卡（新建项目入口 + 一句话说明），演示数据退役；S-R 运行详情仍可用（账本是全局的）。
- **G5' 通知 chip**：概览头 chip 沿用四态，`lastPushedReport` 显示为「项目名/报告名」短形态。
- **G6' 旧端点**：`GET /api/dashboard` 与全局 `/api/reports` 移除（前端同步切换）；旧端点不留兼容层（单机个人工具，前后端同仓同发）。
- **G7'（第 2 轮，收敛）**：当前选中项目持久化在 localStorage（`dp.activeProjectId`），刷新/重启回到最后项目；项目被删回退到列表首个或空态。GRILL 两轮收敛（第 2 轮仅此项新增）。
