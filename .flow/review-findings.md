# M4 REVIEW cycle 1（2026-09-27，fresh code-reviewer 子代理）

## VERDICT: FAIL

整体忠实于 proposal/PRD 决策（期次校验、PUT 防伪、静态服务、launchd/9642、README 双机改写落地，测试证据扎实，SDK API 真实核对无编造），但 1 个 MAJOR 违反 GRILL 决议 1 整体成功语义。

## 发现

**MAJOR-1 [implementation/spec]** 看板兜底推送只发文本却落 lastPushedPeriod，导致该期次高优审批卡片永不发出
- 证据：server/index.ts:257（handleDashboard 兜底调 maybePushNewPeriod，只走 webhook 文本，imChannel 未传入）→ server/notify.ts:132（pushPeriodIdempotent 成功即落状态）→ server/notify.ts:173（scanAndPush 见状态即跳过，卡片通道被幂等门挡死）。
- 后果：导入新周报后 60s 扫描前打开看板且 notify.json 配了 webhook → 文本推送落状态 → 本期全部 high 卡片静默缺失，POST /api/notify/push 手动重推同样只发文本，无恢复手段。违反 GRILL 决议 1 与 user story 15。
- 修复：handleDashboard 兜底改调 scanAndPush（透传 imChannel）。
- 复检：配好 im.json+notify.json 起服务，导入新期次后立刻 GET /api/dashboard，断言 sendApproval（文本+卡片）随后仍被发出。

**MINOR-1 [implementation]** 卡片回调不校验操作者身份，转发卡的任意租户成员可代批
- 证据：server/im-feishu.ts:110——operatorName 未比对 evt.operator.openId 与 config.approverUserId。
- 修复：回调校验 openId === approverUserId，不符返回拒绝回执。
- 复检：另一 open_id 点卡，store 不变且回执拒绝。

**MINOR-2 [spec]** PC 标记 executed 清空卡片审批人留痕
- 证据：server/actions.ts:68-73——PC PUT executed 时 decidedBy 被丢弃，主流程终点（卡片采纳→运营执行）只剩「PC·时间」。
- 修复：status=executed 且 patch 无 decidedBy 时保留既有 decided*。
- 复检：卡片 accepted（张三）后 PC executed，看板仍显示张三留痕。

**MINOR-3 [implementation]** cardAction 内 writeActionStore 同步抛错冒泡且无回执
- 证据：server/im-feishu.ts:113-119——磁盘异常传播进 SDK 事件层，审批未落库且卡片不更新。
- 修复：handler 整体 try/catch，失败 best-effort updateCard「落库失败，请重试」。
- 复检：注入 write 抛错，进程存活且卡片收到失败回执。

**NIT-1** README「60 秒内自动推送」最坏 ≈62s，与验收「≤1 分钟」有秒级出入；改「约 1 分钟」。
**NIT-2** notify.ts:121 注释引「GRILL 决议 4」编号误导（应为决议 3 语境）。
**NIT-3** scripts/feishu-demo.ts 回调无重入守卫（一次性前置门脚本，无实际影响，仅记录）。

## 测试证据质量核查（正面确认）

- 单测非摆设：路径穿越负例、PUT 防伪负例、调度器 stop、非法载荷 5 组、IM 失败不落状态、过期/重复/非法三态；断言针对外部行为，无同义反复；mock 不吞错。
- SDK 猎杀假证据：createLarkChannel/send/updateCard/on('cardAction')/disconnect 与 CardActionEvent 类型在 @larksuiteoapi/node-sdk@1.74.0 全部真实存在，适配器用法与 SDK 契约一致。
- lockfile 新增均为 lark SDK 传递依赖，无夹带。
- 负例缺口：未覆盖「卡片留痕后 PC executed」的留痕保留（MINOR-2 行为盲点）。

## UNVERIFIED

- 真机实测记录无法复核（脚本与记录逻辑自洽，失败一跑被诚实记录）。
- 卡片转发后按钮回调真实行为（MINOR-1 前提）未实测。
- tasks 8 真实周报走查用 sample 期次代替（与 flow 状态一致）。

## verify 复跑

exit 0；tsc 干净；vitest 16 文件/148 全过（2.26s）；vite build OK（618 modules）。与派发口径一致，无不符。

---

# M4 REVIEW cycle 2（2026-09-27，fresh code-reviewer 子代理）

## VERDICT: PASS

cycle 1 修复逐条判定：MAJOR-1 已修复（独立枚举 sendNotification 全部生产调用点，不存在 IM 在场时只发 webhook 文本并落状态的路径；回归测试断言兜底/手动重推走 IM 通道、webhook 0 次、卡片≥1）；MINOR-1 已修复（openId 比对 fail-closed，未解析 ou_ 前缀时明确提示；伪造面在身份校验之后且不信任卡片自带 period）；MINOR-2 已修复（executionKeepsDecision 仅 executed 无 decided* 且已有留痕时保留；accept→reject 被「已处理」门挡住，PC executed→卡片 accept 提示已执行不落库）；MINOR-3 已修复（handler try/catch，「目录当 actionsFile」注入真实 rename 失败，断言不冒泡+失败回执）；NIT-2 已修复；NIT-3 按约定不修。

全量复查（75554a00 固定点，21 修改 + 10 新文件）：无新 BLOCKER/MAJOR。SDK 契约独立核对无假证据；lockfile 新增 50 包均为 lark SDK 传递依赖；`git ls-files data/` 确认 im.json 凭证未入库；GRILL 决议 1-10 与 proposal §8 逐条比对无偏差。

## 非阻塞建议（记录为后续候选，README 已列入）

- SUGGEST-1：桥接启动失败后永久静默降级且该期卡片不自动补发（PRD 定义了降级，但永久性+不可见性超规格意图）——建议周期重试建桥或健康暴露降级状态。
- SUGGEST-2：非审批人点击会把卡片替换为无按钮结果态，审批人失去该卡入口——建议拒绝回执改为新发提示消息不替换原卡。
- NIT-1 残留（README:78「60 秒内」）已补修为「约 1 分钟」。

## UNVERIFIED

真机链路（卡片样式/重连/停机提示）依赖 walkthrough 记录，逻辑自洽；tasks 8 用 sample 期次代替真实周报（与 flow 状态一致，诚实记录）。

## verify 复跑

exit 0；tsc 干净；vitest 16 文件/152 全过（2.14s）；vite build OK（618 modules）。与派发口径完全一致。
