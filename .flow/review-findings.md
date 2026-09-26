# REVIEW Findings — M3（cycle 1）

> 审查者：code-reviewer 子代理（新实例）。基线 d13c84fff902078c084ca8811ac5c7a18ecc1d4b，baseline_dirty=[.zcodeignore]。要点保存。

**VERDICT: FAIL（REQUEST_CHANGES）** — 三大件与打磨项主体落地、数字自洽独立复算成立、verify 证据复现；但：

- [BLOCKER] server/index.ts 异步路由处理器无 rejection 兜底：PUT /api/actions/%（URIError）或引擎异常/目录缺失（readdirSync ENOENT）→ unhandled rejection → **进程 exit 1**（实测两路径均致命）；违背 PRD story 15「5xx」语义。
- [MAJOR] 手动推送复用幂等门，已推过即 no-op——与 PRD/README「重推/补救」相反（自动推送成功但消息丢失时无法补救）。
- [MAJOR] 自动推送被 await + 失败不落状态 → webhook 不可达时每次打开看板都等满 5s。
- [MAJOR] notify chip「已推送」在已配置但推送失败/未推时仍显示——红队 KA4 要防的误信场景。
- [MINOR×6] 写存储 IO 错误与参数校验同走 400；executedNote 非字符串可入库；同日期多份 CSV 未去重且 M2 文档化行为被静默改；notify 竞态未按 GRILL 决议注释明示；**tasks.md 残留 M2 内容（流程债）**；README 里程碑行自相矛盾。
- [NIT] stubFetchByRoute log 参数死代码。

## 修复记录（cycle 1 → cycle 2）

- BLOCKER：路由层统一 guard（.catch → 500，headersSent 防重）；decodeURIComponent 单独守卫 → 400；handleDashboard 构建单独 try → 500。测试：%/目录缺失两路径 400/500 且 /api/health 存活。
- MAJOR：手动推送改直接 sendNotification + 落状态（真正重推，测试钉住 webhook×3）；自动推送改 void fire-and-forget（挂起 webhook 下 dashboard <2s 返回）；chip 三态（已推送·期次 / 已配置·未推送 / 推送未配置）。
- MINOR：写盘 IO 5xx 与校验 400 分离；executedNote typeof 校验；parseHistory 同日期去重（首个生效+告警）；竞态注释补明示；README 里程碑更正；tasks.md 重写为实际 M3 拆解并勘误。
- VERIFY：npm run verify exit 0 — 117/117 tests（13 files）。→ REVIEW cycle 2。


---

# REVIEW Findings — M3（cycle 2）

**VERDICT: PASS（APPROVE_WITH_COMMENTS）** — cycle 1 全部修复独立实测通过（进程兜底/重推/fire-and-forget/chip 三态）；数字自洽复算成立；verify 复现。余 4 MINOR + 6 NIT：

- [MINOR] actionReview 无期次窗口、当周行动即入对照且永不下窗口（与 PRD「key=conclusionId+期次」相悖）
- [MINOR] thisWeek 口径硬编码 memberSales
- [MINOR] README 未明示 127.0.0.1 安全边界（GRILL 决议 5）
- [MINOR] 手动/测试推送无前端按钮（PRD 仅承诺端点——记录为后续候选）
- [NIT×6] c-cross 无冲突兜底、digest「要拍板 N 件事」计数粒度、PUT period 空串、tasks 未勾选、MetricPoint 注释、备注回滚不刷新

## 修复记录（cycle 2 → cycle 3）

- actionReview 加期次窗口（仅往期）+ 指标口径随所属结论（人数口径不显示万）；README 补本地监听警示；c-cross 兜底；digest 改「本周结论 N 条（高优先级 X 条待拍板）」；PUT period 空串 400；MetricPoint 注释更正；备注输入 key 重挂载（回滚刷新）；tasks.md 勾选。
- 新增回归：期次窗口两例、指标口径例、digest 措辞。
- VERIFY：npm run verify exit 0 — 119/119（13 files）。→ REVIEW cycle 3（终审）。


---

# REVIEW Findings — M3（cycle 3）

**VERDICT: FAIL** — cycle 1/2 修复全部实测通过、数字自洽成立；但发现 cycle-1 崩溃类残余路径：

- [BLOCKER] server/index.ts:48 `new URL()` 在 guard 之前同步执行——`GET //`（及 `http://[` 等）→ TypeError → 进程 exit 1（原始 socket 实测 4 种目标全部击杀；对照组正常）。
- [MINOR] 演示回退期点行动落 `period:''` 记录 → `record.period !== report.period` 恒真 → 永久混入对照块。
- [NIT] dashboard/engine 同名 totalOf 两种签名；actions 写非原子；GRILL 决议 6 措辞偏差（alert vs 行内，功能等价记录）；前端推送按钮维持后续候选。

## 修复记录（cycle 3 → cycle 4）

- BLOCKER：`new URL` 包 try/catch → 400（原始 socket 回归测试：GET // → 400 且 health 存活）。
- MINOR：review 侧过滤空 period + 前端 `setAction(…, persist)` 开关（演示期仅本地乐观更新不落库，两测钉住）。
- NIT：dashboard totalOf→sumCurrentOf（消同名异签）；actions 原子写（tmp+rename）；措辞/按钮记录不改。
- VERIFY：npm run verify exit 0 — 122/122（13 files）。→ REVIEW cycle 4（终审，最后额度）。


---

# REVIEW Findings — M3（cycle 4，终审）

**VERDICT: PASS（APPROVE_WITH_COMMENTS）** — 前三轮修复全部独立实测成立（原始 socket GET //→400 存活、真实 webhook 三语义、空 period 过滤、数字自洽独立复算吻合）；verify 复现（122/122）。无阻断。

## CONVERGE（cycle 4）

无阻断 → SHIP。7 项 minor/nit 记录为后续打磨：
1. 对照块"往期"过滤而非"最近 1-2 期"窗口——数月后无界累积（建议 period 降序+截断）。
2. HTTP 路径静默丢弃非法 executedNote/text/dimension（纯函数校验在 HTTP 不可达，应直传得 400）。
3. writeNotifyState 非原子写（对称性）。
4. digest 结论列表未显式 severity 排序（当前依赖引擎输出顺序）。
5. POST /api/notify/push 可被浏览器跨站触发（CSRF，127.0.0.1+无鉴权边界已文档化，影响=多发摘要）。
6. validMonthDay 不查月份长度（2026-02-31 接受，仅排序键无后果）。
7. useActionStore 回滚 refetch 与后续点击的小竞态（数据无损，GRILL 决议 6 范围）。
