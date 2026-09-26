# REVIEW Findings — M2 会员周报异动检测与归因（cycle 1）

> 审查者：code-reviewer 子代理（新实例，冻结输入审查）。基线 f2e8f16cc676f302cc691a4a94c093bf54fe7a38，baseline_dirty=[.zcodeignore]（排除）。要点逐字保存（M1 期间的本文件内容见 git 历史 c65005d）。

**VERDICT: FAIL（REQUEST_CHANGES）** — 规格实现与真实样本数字自洽全部独立复算通过（含 verify 原样复现 63/63），但主动猎杀发现 2 个阻断性缺陷。

## 阻断（BLOCKER）

1. **[server/report/types.ts:33-35 + server/rules/engine.ts:219,225] 同期为 0 的渠道产出 `+Infinity%` 叙述（除零）**。实测合成行（新渠道 prev=0）经 R4 bigPath 触发，标题/derivation/breakdown delta 均出现 `+Infinity%`，违反数字自洽契约；周报新增加盟主体无同期基数是常规事件。复核标准：prev=0 行不再出现 Infinity/NaN，且仍可进大额偏离结论（叙述写「同期无基数」）。
2. **[server/report/parseCsv.ts:35-41] 空数值单元格静默解析为 0**（`Number('')===0` 过校验），比丢数据更糟且直接链入 blocker 1；任务 1 验收明确「坏数字显式报错」。复核标准：空单元格抛 ReportParseError 含行号，63 测试仍绿。

## 建议（SUGGESTION，本 flow 随修）

- R3 标题把开卡异动标成「会员购买人数」（潜伏缺陷，无测试覆盖）→ 按指标名取标题 + 补合成夹具测试。
- extractPeriod 注释称回退当前日期实际返回 ''，与 PRD story 9 矛盾 → 无日期文件名按解析失败处理（回退演示 + 显式告警），修正注释。
- fmtWan 对存量值也加 +/- 号（「同期基数 +1,169 万」误导）→ 拆 delta/level 两个函数，与 ContributionChart 的重复实现一并提取共享。
- R5 交叉信号无规模门槛（proposal 约束级结论 2）→ 补基数门槛，说明记录在 RULES。
- themedMetrics 死守卫（R3 只遍历两个永不在集合中的键）→ 删除。
- 表头后零数据行被接受（isDemo:false + 0 结论）→ rows 为空抛错走演示回退。
- R2 严重度恒 high，PRD 写 high/medium → 双萎缩 high、单萎缩 medium。
- ContributionChart 负值条 label position 'right' 可能贴零轴侧 → 按符号分侧（正 right 负 left）。

## 待确认（UNVERIFIED，记录）

- vite preview（4180）无 /api 代理必然回退演示数据——README 承诺路径是 dev:all，属有意为之，README 补一句说明。
- 浏览器级渲染细节（负值条标签遮挡）由按符号分侧修复 + 截图复核。

## 审查覆盖（摘）

diff 全部 19 个文件通读；fixture 与 data/raw 逐字节比对一致；独立 node 复算全部叙述数字与引擎输出一致（含 +8.8%/-5.9%/14.7pt/+1,141 万/±38.7%/−23.5%/−2,795 人）；6 组边界探针（prev=0、memberDev=0、全零同期、空行、空单元格、无日期文件名）直跑真实引擎/解析器；verify 原样重跑一致。

## CONVERGE 分类（cycle 1）

- 2 项 BLOCKER：阻断，修复。
- 8 项 SUGGESTION：全部随修（均为小改且直接服务约束/信噪比）。
- 2 项 UNVERIFIED：一项随修（label 分侧），一项 README 补说明。
- review_cycles: 0 → 1，→ IMPLEMENT（以上为唯一工作项）→ VERIFY → REVIEW cycle 2。

## 修复记录（cycle 1 → cycle 2）

- BLOCKER 1：`yoy` 对 previous=0 返回 null，引擎/明细统一「同期无基数」叙述；R4 大额偏离路径仍可命中（合成行测试钉住：无 Infinity、进结论、delta=同期无基数）。
- BLOCKER 2：`parseNumber` 空单元格抛错含行号（测试）；表头后零数据行同样抛错（随修 6）。
- R3 标题按指标名 + 合成夹具两测（随修 1）；extractPeriod 无日期→上层抛错回退演示 + 测试（随修 2）；fmtWan 拆 delta/level 并与图表共享（随修 3）；R5 基数门槛 ≥100 人 + 正反两测（随修 4）；themedMetrics 死守卫删除（随修 5）；R2 双萎缩 high/单萎缩 medium + 两测（随修 7）；贡献图负值标签分侧 + 测试（待确认 1）；README 补 preview 说明（待确认 2）。
- VERIFY：npm run verify exit 0 — 71/71 tests（9 files）。→ REVIEW cycle 2（新实例）。

---

# REVIEW Findings — M2（cycle 2）

**VERDICT: PASS（APPROVE_WITH_COMMENTS）** — cycle 1 全部修复独立复核通过；真实样本全部叙述数字独立复算吻合；verify 原样重跑一致（71/71）。无新增阻断。

- [Major] 下滑周（memberDev<0）中 topPull/topDrag 不分符号：镜像场景实测同一负贡献渠道被同时标为「最大拉动」与「最大拖累」（叙述假陈述，当前样本不触发但高概率周度场景）。复核标准：拉动只标正贡献、拖累只标负贡献 + 回归测试。
- [Minor] 前端缺「HTTP 200 + isDemo:true」分支测试（任务 5 验收第三分支）。
- [Nit] 空行被前置过滤导致报错行号偏移物理行；多列行静默接受（文档化容忍）；loading 设计取舍（已注释，记录）；同日期 CSV 平局取 readdir 顺序（文档化）。

## CONVERGE 分类（cycle 2）

- Major = 叙述正确性缺陷 → 阻断（review_cycles 1→2，最后额度）；Minor 随修；Nit：行号物理化随修，其余文档化/记录。

## 修复记录（cycle 2 → cycle 3）

- Major（下滑周符号）：topPull/topDrag 改为按符号取（|贡献| 序首个正/负），R1 归因分句化条件拼接、R4 对照加缺失守卫；镜像夹具回归测试（分句级断言：同一渠道不同时双标、拉动句只含正贡献渠道、下滑渠道对照指向正贡献）。
- Minor：前端补「200 + isDemo:true」第三分支测试。
- Nit：空行不再预过滤（行号=物理行，含空行夹具测试）；多列行容忍与同日期平局行为文档化于代码注释。
- VERIFY：npm run verify exit 0 — 74/74 tests（9 files）。→ REVIEW cycle 3（终审，最后额度）。

---

# REVIEW Findings — M2（cycle 3）

**VERDICT: FAIL** — 前两轮全部修复复核通过、真实样本数字复算吻合、下滑周镜像 4 场景验证符号正确；但发现 1 个当前真实看板即触发的阻断：

- [BLOCKER] R2/R5 的 metricIds[0]（memberSales/开卡）≠ breakdown 指标（新客购买/会员购买），导致证据区把人数渲染成万元/¥：贡献图标签「+0 万」（实际 +3,109 人）、归因表当前值「¥14,898」（人数）、R5 图注指标名与数据张冠李戴。违反数字自洽契约与 PRD story 7/8/15。复核标准：7 张卡逐一渲染，人数类归因不出现万/¥，图注与数据一致。
- [SUGGESTION] R4 severity 恒 medium，PRD 写 medium/low——low 不可达；补判定或文档化。
- [SUGGESTION] severityRank 与 M1 SEVERITY_RANK 重复——复用 sortConclusions。
- [UNVERIFIED] UTF-8 BOM 表头会失配（Excel 导出常见）——加 BOM 剥离。

## CONVERGE 分类（cycle 3）

- BLOCKER：阻断（review_cycles 2→3，最后额度）：R2/R5 metricIds 重排（归因指标置首）+ ContributionChart 按指标格式选择标签格式（currency→万 / number→带符号人数）。
- 2 SUGGESTION + BOM：随修（fastPath-only→low + 测试；复用 sortConclusions；BOM 剥离 + 测试）。

## 修复记录（cycle 3 → cycle 4）

- BLOCKER（人数渲染成万/¥）：R2 metricIds 重排为 [newMemberBuyers, newMemberRepeat, memberSales]、R5 重排为 [memberBuyers, memberNewCards]（归因指标置首，证据区格式与数据同源）；ContributionChart 标签按量纲格式化（currency→万 / number→带符号千分位），ConclusionCard 按 primaryMetric.format 传递。测试：R2/R5 metricIds[0] 断言、count 格式标签断言；真实数据 e2e 核对 7/7 结论对齐。
- R4 分级落地：bigPath（含双路径）→ medium，fastPath-only（高增速低体量）→ low，正反两测（真实样本西南加盟仍 medium、合成低体量高波动 low）。
- severityRank 重复 → 复用 src/data 的 sortConclusions。
- BOM 剥离 + 测试（Excel 导出兼容）。
- VERIFY：npm run verify exit 0 — 78/78 tests（9 files）。→ REVIEW cycle 4（终审）。

---

# REVIEW Findings — M2（cycle 4，终审）

**VERDICT: PASS（APPROVE）** — 两轴干净：前三轮修复全部独立复检成立；真实样本全部叙述数字自写解析器独立复算吻合；7/7 结论 metricIds[0] 与归因指标一致、量纲链路闭合（number→count / currency→万）；verify 原样复现（exit 0，78/78）；无 Infinity/NaN/undefined、无范围外改动、无注入面。

## CONVERGE（cycle 4）

无阻断 → SHIP。3 条建议记录为 M3 打磨项：
1. extractPeriod 紧凑分支接受任意 8 位数字串（99999999.csv 会被当日期且排序最高）→ 校验月日范围。
2. dashboard catch-all 建议收窄为仅 ReportParseError（引擎缺陷显式上抛而非吞入演示回退）。
3. BreakdownTable 金额列全精度元展示，可复用 formatWanDelta/Level 提升与图表的一致可读性。
