# PRD · M3 告警推送、行动闭环、多周趋势

> 事实源：`.flow/proposal.md`；对齐 `.flow/red-team.md`。项目无 issue tracker，落盘 `.flow/prd.md`（降级路径）。

## Problem Statement

M2 后看板能算出本周结论，但三处断裂：行动状态刷新即失、无执行追踪，上周动作与本周结果无法对照；结论躺在看板里等人主动打开；单期截面看不到走势（数据已在累积）。

## Solution

行动状态后端 JSON 持久化（待定/采纳/驳回/**已执行+备注**），新期次计算后后端装配"上周行动 → 本周表现"对照；新期次首次计算自动推送决策摘要（通用 webhook，幂等，推送状态上看板）；解析 `data/raw/` 全部历史周报生成整体指标周度时序，启用结论展开区的趋势折线（<2 期降级提示）。

## User Stories

1. 作为运营决策者，我标记的行动状态在刷新/重启后保留，以便跨天跨周追踪。
2. 作为运营决策者，我想把"采纳"的行动推进为"已执行"并写执行备注，以便记录落地动作。
3. 作为运营决策者，我想看到"上周行动对照"区（上周采纳/已执行的行动 → 本周相关结论/指标变化），以便复盘动作效果。
4. 作为用户，行动汇总区显示含"已执行"的状态计数，与结论卡状态一致（同一后端事实源）。
5. 作为运营决策者，新周报导入算出结论后自动收到一条推送（本周要拍板的 N 件事 + 关键数字），以便不用记得打开看板。
6. 作为用户，重复刷新/重启不会重复推送（新期次只推一次）。
7. 作为用户，看板概览头显示推送状态（未配置 / 已配置 · 最近推送期次），以便不误以为推了。
8. 作为看板维护者，webhook 配置放 `data/notify.json`（gitignore，凭证不入库），以便凭证安全。
9. 作为看板维护者，我可以手动"重推本周摘要"与"发送测试消息"，以便验证配置与补救。
10. 作为用户，推送摘要里的数字与看板同源（自洽契约延伸到推送侧）。
11. 作为运营决策者，累积 ≥2 期后，结论展开区出现所引指标的周度趋势折线（每点一期），以便看走势。
12. 作为用户，历史 <2 期时趋势区显示"累积 ≥2 期周报后展示趋势"提示，而非空白或报错。
13. 作为用户，概览头显示当前期次与历史期数，以便知道趋势的数据基础。
14. 作为用户，8 位数字串文件名（如 99999999.csv）不再被误判为日期。
15. 作为用户，引擎代码缺陷显式上抛（5xx/日志），不再被吞成"演示数据"静默回退。
16. 作为用户，归因明细表金额列以万元展示，与贡献图口径一致。
17. 作为 MacBook 用户，拉取仓库后无需 notify.json/actions.json 也能正常起服务（推送跳过、行动从空开始、状态明示）。
18. 作为用户，所有新端点与纯函数有测试，`npm run verify` 全绿。

## Implementation Decisions

- **行动存储（server/actions.ts）**：`data/actions.json`，`Record<actionId, { status: 'pending'|'accepted'|'rejected'|'executed'; executedNote?: string; period: string; updatedAt: string }>`。API：`GET /api/actions` 全量返回；`PUT /api/actions/:id` 更新（status/executedNote 白名单校验）。文件不存在视为空 store；写失败显式 5xx。
- **渠道结论 id 稳定化**：M2 的 `c-ch-${i+1}` 序号 id 跨周会错位，无法支撑对照——改为按维度 slug（如 `c-ch-西南加盟` 类稳定键，由 运营模式+渠道 生成）；R1/R2/R5/R3 id 本就语义稳定。行动 store 的 key = conclusionId + 期次。
- **跨周对照（后端装配）**：`buildDashboardData` 读取 actions store，在响应中新增 `actionReview: Array<{ actionId, text, dimension?, status, executedNote, period, thisWeek?: string }>`——thisWeek 为该行动指向渠道/指标在本期结论中的表现摘要（无则"本期无相关异动"）。前端在行动汇总区上方渲染对照块。
- **推送（server/notify.ts）**：配置 `data/notify.json = { platform: 'feishu'|'dingtalk'|'wecom'|'generic', url }`（gitignore）。三平台 text 消息 payload 差异在发送层适配；`generic` 为裸 JSON POST。摘要由纯函数 `buildWeeklyDigest(data): string` 生成（结论标题 + 严重度 + 行动计数 + 打开地址提示）。幂等：`data/notify-state.json = { lastPushedPeriod }`——`/api/dashboard` 发现 `period > lastPushedPeriod` 且已配置时 fire-and-forget 推送并更新状态；响应携带 `notify: { configured, lastPushedPeriod }`。手动：`POST /api/notify/push`（重推本期）、`POST /api/notify/test`（固定测试文本）。推送失败只记日志，不阻塞看板。
- **多周趋势（server/dashboard.ts + report 层）**：解析 `data/raw/` **全部** CSV（日期升序）→ `history: WeeklyReport[]`；生成**整体 6 指标的周度序列**填充 `DashboardData.series`（points 每期一个，date=期次），结论 `metricIds[0]` 自然匹配启用 M1 折线（x 轴=期次）。渠道级趋势明确不做（Out of Scope）。`historyCount` 随响应返回，概览头显示期次与期数；<2 期时 series 为空（现状降级路径不变，贡献图兜底）。
- **前端**：`useDashboardData` 扩展为同时拉取 actions（或独立 `useActionStore` hook），状态变更走 PUT + 乐观更新；行动汇总区/结论卡共享后端事实源；新增"已执行"按钮与备注输入、"上周行动对照"块、概览头推送状态 chip 与期数。
- **打磨三项**：`extractPeriod` 紧凑分支加月日范围校验；`server/dashboard.ts` 仅捕获 `ReportParseError`（其余上抛）；`BreakdownTable` 在 metricDef.format=currency 时贡献/当前值列用 `formatWanDelta/formatWanLevel`。
- **.gitignore 追加**：`data/notify.json`、`data/notify-state.json`、`data/actions.json`（运行期本地状态，不入库；MacBook 各自独立——README 明示）。

## Testing Decisions

- 只测外部行为；测试缝（IMPLEMENT 时与用户确认）：
  1. **ActionStore/时序装配/digest 纯函数**：文件 IO 注入临时目录（mkdtemp）。
  2. **webhook 发送边界**：mock fetch，断言三平台 payload 形状、失败不抛、幂等状态文件更新。
  3. **API 端点**：注入 dataDir/tmpdir 起真实 server（延续 server.test 模式）。
  4. **前端数据获取边界**：mock fetch（dashboard+actions+对照区渲染、乐观更新回滚）。
- echarts 渲染边界不变（组件契约测试）。
- 自洽契约延伸：digest 文本中的数字断言与 dashboard 同源。

## Out of Scope

趋势检测规则（连续 N 周，待 ≥4 期数据校准）、渠道级趋势折线、定时调度（launchd/cron 仅 README 建议）、邮件/短信/多渠道、多用户权限、数据库/DuckDB、公网部署。

## PRD Diff（相对 proposal.md，gated 待确认）

1. **【收窄】多周趋势 v1 = 整体 6 指标周序列 only**：提案写"整体 6 指标 + 结论涉及的渠道指标"，PRD 收窄为整体 only（渠道级进 Out of Scope）——理由：series 与结论的关联机制会复杂化 M1 类型，整体趋势已满足"看走势"的主诉求，渠道表现本期由归因明细承载。
2. 【新增】渠道结论 id 从序号（c-ch-N）稳定化为维度 slug——跨周对照的必要结构前提。
3. 【新增】跨周对照由后端装配（dashboard 响应 actionReview 字段），前端只渲染。
4. 【新增】推送幂等状态文件 data/notify-state.json 与响应内 notify 状态字段（红队 KA4：推送状态上板）。
5. 【新增】行动状态机字段（status 四态 + executedNote + period + updatedAt）与 GET/PUT API 形状。
6. 【新增】前端行动状态改后端事实源（PUT + 乐观更新），推翻 M1"内存态"的有意决策——提案已声明持久化，此为细化。
7. 【新增】data/*.json 运行期文件 gitignore + README 双机行为说明。

## GRILL 决议（自答记录，2026-09-26）

提案/PRD 留白的实现级空隙，按推荐自答（无提案冲突，无需升级）：

1. **摘要文案**：纯文本 ≤15 行——期次标题 + 按严重度列结论标题（≤5 条）+ 行动计数（待定 N/已执行 N）+「打开看板拍板」提示；不带渠道明细（看板内看）。
2. **已执行备注**：可选（允许为空），输入框 placeholder「执行说明（可选）」。
3. **渠道 slug**：`${mode}-${channel}` 规范化（去空白/斜杠）；mode+channel 在单期周报内唯一（加盟/直营区分同名分公司），理论冲突仍以序号兜底。
4. **推送竞态**：单机单用户，notify-state 读-改-写接受理论竞态（代码注释明示），不引入文件锁。
5. **PUT 鉴权**：无（服务仅绑 127.0.0.1，README 明示勿暴露公网）。
6. **乐观更新失败**：回滚本地状态 + 行内错误小字（warn 色），不引入 toast 基建。
7. **缝确认**：PRD §Testing Decisions 四缝已随 PRD 整体确认（用户「确认」覆盖），IMPLEMENT 不再重复询问。
