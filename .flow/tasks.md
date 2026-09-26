# 任务拆解 · M3 告警推送、行动闭环、多周趋势

> 来源：`.flow/prd.md`（含 GRILL 决议）；gated 拆解自批准（2026-09-26）。
> **勘误（REVIEW cycle 1 发现）**：本文件曾因写入失败残留 M2 内容而 state 声称已更新——流程债，已补正。下列 7 项为实际执行的 M3 拆解（均已实现）。

- [x] 1. M2 遗留打磨三项（日期月日校验 / catch 收窄 / 金额列万元化）
- [x] 2. 行动存储与 API（actions.json + GET/PUT，可注入路径）
- [x] 3. 渠道结论 id 稳定化（维度 slug）+ 跨周对照装配（actionReview 后端生成）
- [x] 4. 多周趋势（全历史解析→整体 6 指标周序列，<2 期降级，historyCount）
- [x] 5. 告警推送（notify 配置/摘要纯函数/三平台 payload/幂等状态/手动端点）
- [x] 6. 前端接线（useActionStore 乐观+回滚、已执行+备注、对照块、概览头状态）
- [x] 7. 收尾（gitignore 运行期文件、README 双机说明、走查更新、端到端实测）

## 各任务要点与验收（摘要）

1. **打磨**：99999999.csv 拒绝为日期；引擎异常上抛非演示回退；金额归因列万元化——三项均有回归测试。
2. **行动存储**：data/actions.json，四态 + executedNote + period + text + dimension（均首次记录）；PUT 白名单校验 400、文件可注入 tmpdir。
3. **id 稳定 + 对照**：c-ch-${mode}-${channel} slug（冲突序号兜底）；buildActionReview 仅 accepted/executed 进对照，thisWeek 数字由本期 CSV 复算。
4. **趋势**：parseHistory 全量解析（最新一期损坏上抛回退演示、旧文件损坏跳过）；buildOverallSeries ≥2 期出 6 条周序列；响应含 historyCount。
5. **推送**：buildWeeklyDigest ≤15 行结论先行；feishu/dingtalk/wecom/generic payload；maybePushNewPeriod 幂等；POST /api/notify/push|test。
6. **前端**：useActionStore（GET 初始化、PUT 乐观、失败回滚+行内错误）；ActionItem 四态+备注输入；ActionSummary 对照块；概览头期数/notify chip/单期趋势提示。
7. **收尾**：gitignore 三运行期文件；README M3 与双机说明；walkthrough M3 交付核对；e2e 四项实测（行动闭环→对照数字、双期趋势、清理恢复）。

## REVIEW cycle 1 追加工作项（阻断/主要修复）

- [x] 异步路由兜底：畸形 URL / 引擎异常 → 400/500，进程不崩；/api/health 存活
- [x] 手动推送真正可重推（绕过幂等门）；自动推送 fire-and-forget 不阻塞看板响应
- [x] notify chip 修正：已配置未推送 → 「已配置 · 未推送」（不显示「已推送」）
- [x] 小项：写存储 IO 错误 5xx 区分、executedNote 类型校验、同日期 CSV 去重、notify 竞态注释、README 里程碑行、tasks.md 勘误（本文件）
