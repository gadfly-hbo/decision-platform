# M5 任务拆分（tracer-bullet 垂直切片）

依据：`.flow/prd.md`（含 G1-G14）+ `.flow/ui-contract.md` v3。无 issue tracker，按 dev-flow 降级写本文件。

## 切片总览（依赖与故事覆盖）

- [x] 1. SDK 适配层与抽取 Worker
- [x] 2. SQLite 存管与报告抽取管线
- [x] 3. 行动闭环 API（确认/驳回理由/人工补充/任务/反馈）
- [x] 4. 工作台前端（三栏壳+行动项列表+证据）与新 dashboard，旧管线退役
- [x] 5. 任务/反馈/补充建议 UI 与驳回弹窗
- [x] 6. 飞书审批适配、推送调度与校准注入
- [x] 7. 运行详情抽屉与收尾（README/文档）

依赖链：1→2→3→{4,6}；4→5；4+1→7。每片完成 = `npm run verify` 绿 + 片内验收可演示。

---

## 1. SDK 适配层与抽取 Worker

### What to build
业务代码唯一触达 `pi-agent-runtime`（vendored `file:vendor/pi-agent-runtime-0.4.1.tgz`）的适配层：模型链（MiniMax-M3 主 + mimo-v2.6-flash 备，密钥环境变量优先、缺省读 `~/.pi/agent/auth.json`，缺密钥降级不抛）、JSONL 审计 sink（append 即持久确认、失败上抛）、文件持久任务账本 BudgetStore（同任务唯一 lease、配置签名、重启不清账、`cumulative:'unlimited'` + 单次保护参数：maxOutputTokens 8192 / modelTimeoutMs 120s / controlTimeoutMs 30s）、本地授权策略（model/publish 放行、无工具）。其上封装 `runExtraction(reportText, calibration?) → ActionItemDraft[]`：`createRuntime` + `runWorker`，prompt 对齐 pi-xanthil Actions（严格 JSON、quote 逐字、证据降级、空数组兜底、G12 校准注入位），validator = 归一化纯函数（JSON 数组提取与宽松修复、scene/lifecycle/priority/effort 枚举、evidence 结构化与四级降级、confidence 派生公式 base(level)+quote 加成/无 facts 封顶 0.5、占位拒绝）。

### Acceptance criteria
- [ ] 归一化纯函数单测：合法/宽松 JSON（注释/尾逗号）、枚举非法值降级、evidence 缺失降级经验假设、confidence 公式边界（0.9/0.75/0.55/0.3 + quote 加成上限 +0.1、无 facts 封顶 0.5）、空数组与占位拒绝、输入裁剪与脱图
- [ ] `runExtraction` 用 `pi-agent-runtime/testing` `createReplay` 合成 transport 离线测：正常抽取、模型输出坏 JSON 抛错语义、备用链切换
- [ ] 账本/审计行为测试：同任务二次 lease 拒绝、审计写失败关闭准入（注入失败 sink）、密钥缺失时 `modelChainAvailable()=false` 不抛
- [ ] `npm run verify` 绿

### Blocked by
None - can start immediately

---

## 2. SQLite 存储与报告抽取管线

### What to build
`node:sqlite` 单文件库（`data/board.db`，路径可注入）：`reports`（slug 身份、文件名、导入时间、status: pending/extracting/done/failed）、`action_items`（含 `source_kind extracted|manual`、`report_id` 可空、`dismissed_reason`、evidence_json/evidence_level、confidence、审批留痕 decided_by/at/via）、`action_tasks`（外键级联）、`action_feedback`（一任务一条）。报告扫描：`data/raw/` 下 `.md/.txt` → 注册/更新 reports（未处理才触发）。手动抽取端点 `POST /api/reports/extract`（默认处理未成功报告；`force:true` 按 G3 语义删除重建 suggested、保留已决/有任务项）与 `GET /api/reports`。抽取失败落 failed 状态与原因，可重试。SDK runner 经 ServerOptions 注入（测试用假 runner，不调真实模型）。

### Acceptance criteria
- [ ] 存储单测：四表 CRUD、外键级联、evidence_json 往返、可空 report_id（人工项）
- [ ] 报告管线测试：新报告注册、同文件不重复注册、已 done 不自动重抽、force 重抽保留 adopted/dismissed/有任务项、失败可重试
- [ ] HTTP 测试（注入假 runner + 临时库）：extract 触发与状态迁移、无报告 400、runner 抛错落 failed
- [ ] `npm run verify` 绿

### Blocked by
- 1（runExtraction 缝）

---

## 3. 行动闭环 API（确认/驳回理由/人工补充/任务/反馈）

### What to build
行动项全生命周期端点：`GET /api/dashboard`（聚合：报告列表+状态、行动项统计、全量行动项含任务与反馈、通知状态、模型链可用性——新形状）、`POST /api/actions`（manual 走 G11 校验：标题/依据必填、evidence 固定经验假设+reasoning=依据、source_kind=manual）、`PATCH /api/actions/:id`（status 迁移 suggested→adopted/dismissed；驳回携带 dismissedReason 必填 ≥2 字（看板渠道）；卡片渠道默认「卡片驳回（未填理由）」；仅 dismissed 可补填且仅默认值可覆盖——G10 语义；decided_by/at/via 留痕）、`GET/POST /api/actions/:id/tasks`、`PATCH /api/tasks/:id`（todo/doing/done、owner、dueDate、priority、note）、`POST/GET /api/tasks/:id/feedback`（一任务一条：adopted/outcome/metricDelta/review/score 1-5 整数）。旧 `/api/actions` JSON 存储与 `PUT /api/actions/:id` 端点保留至切片 4 退役。

### Acceptance criteria
- [ ] dashboard 聚合测试：多报告混合（含人工项）统计正确、无报告时 demo 回退标志、无密钥状态
- [ ] 确认/驳回测试：正常迁移、驳回缺理由 400、理由 <2 字 400、补填覆盖仅限卡片默认值、重复驳回幂等
- [ ] 人工补充测试：必填校验、证据等级固定、归组、sourceKind 标记
- [ ] 任务/反馈测试：CRUD、一任务一条反馈（重复 POST 覆盖或 409——按实现钉死并在测试注明）、score 边界
- [ ] 负向：不存在 id 404、非法 body 400
- [ ] `npm run verify` 绿

### Blocked by
- 2

---

## 4. 工作台前端（三栏壳+行动项列表+证据）与新 dashboard，旧管线退役

### What to build
按 UI 契约 v3 重写前端：三栏 shell（S-L 报告导航 / 主区 S1 概览头+S1b 报告状态条+S6 过滤器+S2 行动项卡片流（S3 证据展开、四级色标、quote 块、警示语）/ S7-S10 演示·空·错误·加载态；右栏占位到切片 7）。token 增补（navy 对、scrim）落 tokens.css。同时完成后端旧管线退役：删除 `server/report/`、`server/rules/`、`server/review.ts`、JSON actions 存储、旧 dashboard 装配与 `/api/dashboard` 旧形状、前端 ConclusionCard/DerivationChain/MetricChart/ContributionChart/BreakdownTable/旧 demo、echarts 依赖。`data/raw/` 旧 CSV 不再读取（文件保留）。通知 chip 数据源接新 dashboard。

### Acceptance criteria
- [ ] 组件测试（沿用 App.test.tsx 注入 data 缝）：三栏渲染、行动项卡与证据展开、四级色标 chip、过滤器四维、演示态 chip、空态、错误态（无密钥/抽取失败）、加载 aria-live
- [ ] 旧形态清除验证：`rg -n "echarts|ConclusionCard|DerivationChain|MetricChart|parseCsv|buildConclusions" src server` 无产品代码命中（测试夹具除外）；package.json 无 echarts
- [ ] 手动浏览器走查：真实报告（假 runner 或真实）→ 看板呈现行动项（截图留 `.flow/ui/` 或记录于 verify 证据）
- [ ] `npm run verify` 绿（旧测试文件随旧实现删除，新测试覆盖新行为）

### Blocked by
- 3

---

## 5. 任务/反馈/补充建议 UI 与驳回弹窗

### What to build
UI 契约 S4/S5/S11/S12/S13：采纳项卡内任务列表（新增/编辑 owner、截止日、状态 todo/doing/done 单选）、反馈表单↔只读块互斥（一任务一条）、驳回理由弹窗（`<dialog>`+showModal、textarea 必填 ≥2 字、焦点管理、Esc 取消、错误文案逐字）、卡片渠道驳回的详情区补填输入、过滤器区「补充建议」表单（标题\*/依据\*+四枚可选下拉）与人工项卡片（「人工」徽标、经验假设灰、固定说明行、人工补充分组）。

### Acceptance criteria
- [ ] 组件测试：弹窗打开聚焦/校验/Esc 取消/确认落库、补填仅 dismissed+默认理由可见、人工项渲染与分组、任务三态单选、反馈互斥切换
- [ ] 端到端组件流：采纳→拆任务→完成任务→回录反馈（注入 data 走 UI 状态）
- [ ] `npm run verify` 绿

### Blocked by
- 4

---

## 6. 飞书审批适配、推送调度与校准注入

### What to build
保留 im.ts/im-feishu.ts 长连接/幂等/留痕机制，审批对象改行动项：卡片=行动项+证据摘要（top quote+等级+置信度）+预期效果，按钮 采纳→adopted / 驳回→dismissed（单键直驳、理由默认值、留痕 decidedVia=card、旧报告卡片过期拒绝、重复点击幂等）。推送漏斗改造：调度器扫描 data/raw/ → 新报告抽取（真实 runExtraction）→ 高优（priority=high）或高置信（数据支撑级）逐条推卡片 + 其余文本摘要；未配置飞书回落群机器人 webhook 文本摘要；幂等键改报告 slug（notify-state 语义平移）；`POST /api/notify/push` 手动重推与 `/api/notify/test` 保留。G12 校准注入：抽取 prompt 注入最近 ≤10 条驳回理由 + ≤10 条人工补充（标题+依据），无数据不注入。周摘要 buildWeeklyDigest 改为行动闭环摘要（本周报告 N 份、建议 X 采纳 Y、任务完成 Z）。

### Acceptance criteria
- [ ] 卡片构造测试：行动项→卡片字段映射、证据摘要、结果态留痕（沿用 im-feishu.test.ts 模式）
- [ ] 漏斗测试（假 channel + 假 runner）：新报告触发一次推送（幂等）、失败报告不推、手动重推真发、高优过滤（低优不占卡片）、webhook 降级路径
- [ ] 校准注入测试：有驳回/人工数据时 prompt 含校准段、无数据 prompt 形态不变
- [ ] `npm run verify` 绿

### Blocked by
- 3（行动项状态迁移与留痕）

---

## 7. 运行详情抽屉与收尾

### What to build
UI 契约 S-R：右栏抽屉（S1 开关钮、默认收起、非模态）——模型链状态（主备+密钥就绪 chip，来自 /api/health 扩展）、任务账本用量 chips（模型调用/token 入出/用时，BudgetStore 快照投影端点）、抽取事件时间线（reports 状态迁移+失败原因投影）。收尾：README 重写（M5 形态、报告输入说明、SDK 接入说明、部署不变）、启动脚本核对、`启动决策看板.command` 冒烟。

### Acceptance criteria
- [ ] 抽屉组件测试：开关、默认收起、数据渲染（用量/时间线/模型链）、空时间线文案逐字
- [ ] 账本投影端点测试：假账本注入返回快照
- [ ] README 与实际行为一致（走查记录）
- [ ] `npm run verify` 绿；`npm run prod` 构建+静态服务冒烟通过

### Blocked by
- 4（壳）、1（账本数据源）
