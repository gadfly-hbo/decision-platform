# 任务拆解 · M2 会员周报异动检测与归因

> 来源：`.flow/prd.md`；auto 模式拆解自批准（2026-09-26）。无 issue tracker，落盘 `.flow/tasks.md`。

- [x] 1. 周报解析层：CSV → WeeklyReport（重算同比、容错、显式报错）
- [x] 2. 规则引擎：检测规则 + 规模门槛 + 归因 → Conclusion[]
- [x] 3. 后端接线：data/raw 发现最新 CSV → /api/dashboard 真实计算（isDemo/period/注入）
- [x] 4. 归因贡献条形图：纯函数 option + 组件 + 证据区接入
- [x] 5. 前端接线与收尾：useDashboardData（fetch/回退/标注）+ 端到端 + 走查更新

---

## 1. 周报解析层：CSV → WeeklyReport

### What to build
解析会员周报 CSV 为类型化 WeeklyReport：自动定位表头行（前导标题行容错）、22 列结构校验（缺列显式报错带行号）、每指标存 {current, previous} 且**同比一律重算**（丢弃声明列）、期次从文件名提取。真实样本复制为 testdata 夹具。

### Acceptance criteria
- [ ] 解析真实样本夹具：22 行、6 指标、同比为重算值（直营浙江零售额 = -1.91% 而非源表声明的 -1.34%）
- [ ] 缺列/坏数字行抛结构化错误（含行号），不静默丢数据
- [ ] 期次提取（如 2026-09-26）可用于 period 字段
- [ ] 解析器纯函数测试全绿

### Blocked by
None - can start immediately

---

## 2. 规则引擎：检测规则 + 规模门槛 + 归因 → Conclusion[]

### What to build
纯函数规则引擎：输入 WeeklyReport，输出 M1 类型的 Conclusion[]。规则集与参数集中在 RULES 常量：整体背离（会员 vs 大盘零售额方向相反差≥10pt，high）、整体结构（会员零售额≥+5% 且新客/复购≤0）、整体异动（|同比|≥5%）、渠道异动（|同比|≥30% 且 基数占比≥1% 且 |偏离额|≥50万，按 |偏离额| 取前 N）、交叉信号（开卡≥+5% 且购买≤-20%）。归因 contribution=本期−同期、dimension=运营模式·二级渠道、按 |贡献| 降序。建议行动模板措辞保守并标注人工确认。全局结论上限 8 条、按严重度排序。

### Acceptance criteria
- [ ] 真实样本断言：整体背离结论存在且数字可复算（+8.8% vs -5.9%）；西南加盟/鲁苏加盟（带运营模式）进入渠道异动归因
- [ ] 门槛过滤实证：湖北直营（+239.9%，基数 66 万/占比 0.15%）不进结论；新零售运营组交叉信号命中
- [ ] 结论数 ≤8；每条 derivation 四步齐、breakdown 按贡献降序
- [ ] 叙述数字（占比/偏离）由计算生成，测试复算对照

### Blocked by
- 1

---

## 3. 后端接线：/api/dashboard 真实计算

### What to build
`/api/dashboard`：发现 `data/raw/` 最新 CSV（文件名日期串排序）→ 解析 → 规则引擎 → DashboardData（period=期次）；目录为空/解析失败时回退 demoData 并置 `isDemo: true`。数据目录可注入（默认 data/raw，测试用 fixture）。DashboardData 类型扩展可选 isDemo/period。

### Acceptance criteria
- [ ] 注入含真实样本的目录：返回真实结论（title/期次/归因可复算）
- [ ] 注入空目录：返回 demoData + isDemo true
- [ ] 既有 /api/health、404 行为不回归；server 测试全绿

### Blocked by
- 2

---

## 4. 归因贡献条形图

### What to build
证据区图表适配截面数据：`buildContributionOption` 纯函数（横向条形、按 |contribution| 排序、正=ok 负=fail 分色、数值格式化）+ ContributionChart 组件（echarts/core 边界内薄封装）+ ConclusionCard 接入：结论有 series 用折线（演示路径不变），无 series 有 breakdown 用贡献条形图。

### Acceptance criteria
- [ ] option 纯函数测试：排序、分色映射、数值标签
- [ ] 组件测试（mock echarts/core）：init/setOption/resize/dispose 契约
- [ ] 真实数据结论展开可见贡献图；演示数据路径不回归（既有测试全绿）

### Blocked by
- 2

---

## 5. 前端接线与收尾

### What to build
`useDashboardData`：拉取 /api/dashboard（loading 态；失败回退 demoData）；App 接线；概览头显示 period、isDemo 时显示"演示数据"chip（warn 色+文字双通道）。收尾：一键启动端到端（dev-all 起来 curl /api/dashboard 为真实数据、页面正常）、真实数据走查文档补 M2 结论、README 简要使用说明（每周放 CSV）。

### Acceptance criteria
- [ ] hook 测试三分支：成功（真实数据渲染）、失败（回退+演示标注）、后端返回 isDemo（直接标注）
- [ ] 端到端：dev-all 起来后 /api/dashboard 返回真实计算、前端页面标题/期次正确
- [ ] `npm run verify` 全绿；走查文档与 README 更新
