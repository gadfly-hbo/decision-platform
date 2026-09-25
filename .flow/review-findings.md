# REVIEW Findings — M1 决策看板（cycle 1）

> 审查者：code-reviewer 子代理（新实例，冻结输入审查）。基线 e4f4b630e2233256371e9bd6b9151634b5b80b4f。逐字保存，未删改。

## 审查结论

**VERDICT: FAIL** — 功能与形态完整、verify 证据真实可复现、16 条 user stories 均有落点，但演示数据中多处叙述性数字（归因占比、"连续 N 日"）与同屏展示的图表/明细表互相矛盾——这恰是本产品"证据可核查"卖点上翻车的内容缺陷，需一轮小修后再收敛。审查范围：基线 e4f4b63 之后全部改动（.flow/tasks.md 勾选 + 全部未跟踪文件，共 30 个文件），已逐一通读并独立重跑 verify。

## 阻断性问题（BLOCKER）

无。

## 严重（MAJOR）

- [src/data/demo.ts:140,180,208,257] 演示数据叙述数字与自身可核对数据不自洽（"数字自洽"约束未兑现）
  证据（node 独立复算）：
  - demo.ts:180（c2 归因）"贡献偏离 +0.44（占 82%）"——实际 0.44/(0.44+0.09+0.05) = **75.9%**，且"其余素材组合计 +0.14"明确把三行都算进分母，任何口径都得不出 82%；
  - demo.ts:140（c1 归因）"-0.42（占 68%）"——实际 0.42/(0.42+0.08+0.06) = **75.0%**（占净值 0.28 则是 150%，均非 68%）；
  - demo.ts:208（c3 标题）"连续 5 日低于对比基线"——series 中 09-19~09-25 连续 **7 日**低于 0.032；
  - demo.ts:257（c4 检测）"连续 5 日低于 1.8% 目标线"——09-17~09-25 连续 **9 日**低于 0.018。
  对照组证明这不是口径问题：c1 的"连续 3 日"（demo.ts:128）与序列完全吻合（09-23~09-25 恰 3 日），说明 c3/c4 的"5 日"是抄了规则阈值当事实陈述。c1/c2 的"贡献之和 ≈ 偏离量"这一条倒是自洽的（-0.28 = 0.72-1.0；+0.58 = 2.1-1.52）。
  归属：implementation（任务 2 演示数据；demo.ts:5 头注自declared"数字自洽约束"）；与 PRD story 5（图表供"肉眼复核异动是否真实"）和 story 6（归因表供定位）直接冲突——用户数一下图中低于虚线的点就会当场推翻标题。
  复核标准：从 series 重算每条"连续 N 日"与"占 X%"，文字与计算一致（或改为"已连续 7 日""规则阈值 5 日已触发"这类准确表述）。

## 建议（MINOR）

- [.flow/tasks.md:73（任务4验收项"图表容器随窗口 resize"）/ src/components/MetricChart.tsx:58-71] resize 声称已验证但无证据。MetricChart.test.ts 只测 `buildMetricOption` 纯函数（3 例），未触达 useEffect/ResizeObserver/chart.resize；docs/m1-acceptance-walkthrough.md §4 验证的是 390px 加载态页面溢出，不是窗口 resize 过渡。归属：task/verify（勾选与证据脱节）。复核标准：补一条 ResizeObserver→chart.resize 的测试或在走查记录中写明做了窗口缩放实测。
- [src/App.tsx:71 / src/components/MetricChart.tsx:78] 声明的数据缝（`AppProps.data`，M2 换数据入口）在边界数据下崩溃：`metricById.get(id)!` 非空断言——首指标 id 未知时展开卡在 `formatMetricValue(undefined,…)` 抛 TypeError；`series.points[points.length-1].value` 在空 points 时抛错。PRD story 14 只要求空数据态（已实现、已测），故非规格违背，而是缝的健壮性缺口。归属：implementation。复核标准：以含未知 metricId / 空 points 的 data 渲染 App 不崩（或在类型/文档标注前置条件）。
- [src/App.test.tsx 全文] 负例覆盖不足（本次契约点名排查项）：无未知 metric id 用例；行动状态只测了"采纳"，未测"驳回"路径；汇总区空过滤态（"该状态下暂无行动"，ActionSummary.tsx:47）无测试。归属：implementation/tests。复核标准：三类负例各有一测且通过。

## 细节（NIT）

- 死代码残留（切片 3 骨架遗留）：src/App.css:137 `.placeholder` 类零引用；src/styles/tokens.css:49 `--focus-ring` token 定义后未用（index.css:13 直接写 `outline: 2px solid var(--accent)`，视觉等价）；src/data/format.ts:10 `severityRank` 导出后零调用；src/components/MetricChart.tsx:41 `isPercent ? b.label : b.label` 两分支相同。归属：implementation。复核标准：`rg` 零引用 / 无效三元消除。
- [src/components/ActionItem.tsx:3-7 vs src/components/ActionSummary.tsx:7-12] 待定/采纳/驳回 label 映射在两处重复声明（Fowler Duplicated Code，判断性提示，非硬伤）。归属：implementation。复核标准：共用一份 STATUS 标签源或明示接受重复。

## 两轴结论

- **Spec 轴：不通过（发现 1 为主）**。16 条 user stories 逐条在代码中有落点（与走查文档 §3 对照属实）；PRD Implementation Decisions 全部兑现（三区形态、四块展开、fail/warn/queue 三级 chip、数据契约字段齐、指标 id 集中引用、ECharts 按需引入、原生 CSS 变量零组件库、两态 React 内置不持久化、4 结论/14 天/渠道-计划两级归因）；Out of Scope 无越界（无后端/检测算法/持久化/暗色/三栏外壳）；GRILL 决议 1-8 全部落地（含 ≤900px、默认展开首条、状态提升单源——均有测试）。唯一实质偏差是发现 1 的演示内容准确性。
- **Code/Standards 轴：通过（仅判断性提示）**。仓库无 AGENTS.md/CLAUDE.md/CONTRIBUTING/CODING_STANDARDS，按 smell 基线审查：仅发现 6（轻度重复）与发现 5（死代码），无 Mysterious Name/Speculative Generality（除死导出一处）等实质问题；无 console.log/debugger/TODO 残留。

## 证据核验

- 独立重跑 `npm run verify`：exit 0，tsc 无输出、25/25 测试（4 文件）、vite build 成功、仅既定已接受的 echarts chunk >500KB 警告——与流内记录证据**逐字吻合**，无虚假证据。
- 抽查 tokens.css 8 个色值 + 字号档（22/17/13.5/10.5）+ 间距 + ≤900px 断点，与 ~/.zcode/design/DESIGN.md 一致，走查文档 §2 的 token 声明属实。
- 基线树核验：e4f4b63 含 .flow 四件 + .gitignore；`git check-ignore` 确认 node_modules/dist/.flow/state.json 均被忽略（GRILL 决议 7、任务 1 验收达成）。
- 任务 1 依赖白名单核验：package.json 仅 react/react-dom/echarts + vite 系/测试系，无日期库/组件库/CSS 框架。

## 覆盖确认

- 已检查：diff 内全部 30 个文件逐行通读（src 全部源码与测试、三份 CSS、配置、index.html、package.json、两份 docs、.flow/tasks.md diff）；verify 独立重跑；demo 数据全部算术声明用 node 复算；token 与设计规范抽查；git 基线/ignore 核验。
- 未检查：未亲自在真实浏览器操作（响应式结论依赖走查文档 + CSS 代码交叉验证，其 390px 修复代码 App.css:398 确实存在）；package-lock.json 未逐依赖审计（白名单以 package.json 为准）；.flow/red-team.md 未读（不在冻结输入清单内）。

---

## CONVERGE 分类（flow 主线记录）

- 发现 1（MAJOR）：**阻断**——spec 轴缺陷（story 5/6 与演示数据矛盾）。修复：文字改为复算准确值（75%/76%、7 日、9 日）。
- 发现 2（MINOR）：**阻断**——验收项与证据脱节。修复：补 MetricChart 薄封装行为测试（init/setOption/resize/dispose）。
- 发现 3（MINOR）：按缝健壮性缺口修复（App 去 `!` 断言，空 points 防御）+ 负例测试。
- 发现 4（MINOR）：**阻断**（测试负例缺口，契约点名项）。修复：驳回路径、空过滤态、未知指标 id 三测。
- 发现 5（NIT）：本 flow 自身切片遗留死代码，随本轮清理（非"记录不动"的外部坏味道）。
- 发现 6（NIT）：提取共享 STATUS 标签源（顺手消除重复，风险为零）。

review_cycles: 0 → 1，→ IMPLEMENT（以上为唯一工作项）。

---

# REVIEW Findings — M1 决策看板（cycle 2）

> 审查者：code-reviewer 子代理（新实例）。基线 e4f4b630e2233256371e9bd6b9151634b5b80b4f。逐字保存。

**VERDICT: FAIL** — 上一轮 6 项发现全部按其复核标准修复到位、verify 证据逐字吻合、两轴结构与 16 条 user stories 落点完好；但独立复算演示数据时发现「数字自洽」缺陷家族仍有两处漏网实例（行动预期影响虚报 5 倍、两处"前 7 日均值"不可由所展示序列复算），与本产品"证据可核查"的核心卖点直接冲突，需一轮小修。

## 阻断（BLOCKER）

- [src/data/demo.ts:201] c2 行动预期影响「预计增量 GMV 约 ¥6,300/日」算术错误，虚报 5 倍。预算增量 ¥600/日 × ROI 2.1 = **¥1,260/日**；¥6,300 = 3,000 × 2.1 是追加前全额 GMV。PRD story 7 的拍板数字。复核标准：改为「约 ¥1,300/日」（或按明示假设重算），node 复算通过。
- [src/data/demo.ts:136、176、81] c1/c2 的「前 7 日均值 1.22 / 1.52」不可由所展示序列复算（窗口前 7 日实为 1.25 / 1.48；c3 的 3.2% 恰等于窗口前半均值，证明口径即窗口前 7 天）。c2 的 1.52 还画在图上 markLine，肉眼复核即对不上；「环比 +38%」按 1.48 实为 +42%，归因合计应 +0.62。复核标准：基线改 1.25 / 1.48 并联动复算，或明示为窗口外对比期。

## 建议（SUGGESTION）

- [src/data/demo.ts:5] 头注自洽约束声明过窄，建议扩为「叙述数字须可由同屏 series/breakdown/行动文本复算」。
- [src/components/MetricChart.test.tsx:59-61] 测试替换 globalThis.ResizeObserver 后未还原（vitest 按文件隔离暂无实害），afterAll 还原即可。

## 两轴结论

- Spec 轴：不通过（两项阻断均为演示内容准确性，非结构缺失）。
- Code/Standards 轴：通过（cycle 1 六项修复全部达标；无死代码/重复/console/TODO）。

## 覆盖确认

diff 内全部 28 个文件逐行通读；独立重跑 npm run verify（exit 0、31/31、仅既定警告——与流内记录逐字吻合）；demo 全部叙述数字 node 复算（cycle 1 修正项 75%/76%、3/7/9 日复核通过）；cycle 1 六项发现逐条对照复核标准全部修复达标；token 抽查与 DESIGN.md 一致。未检查：真实浏览器操作（依赖走查记录）、package-lock 逐依赖审计。

## CONVERGE 分类（cycle 2）

- 两项 BLOCKER：演示内容准确性 = spec 轴缺陷 → 阻断，修复（基线改 1.25/1.48 联动 +38%→+42%、占比 76%→74%、合计 0.58→0.62、影响 ¥6,300→¥1,300）。
- 两项 SUGGESTION：随修（头注扩约、afterAll 还原）。
- review_cycles: 1 → 2，→ IMPLEMENT → VERIFY → REVIEW（cycle 3）。

---

# REVIEW Findings — M1 决策看板（cycle 3）

> 审查者：code-reviewer 子代理（新实例）。基线 e4f4b630e2233256371e9bd6b9151634b5b80b4f。逐字保存（要点）。

**VERDICT: FAIL** — 前两轮 10 项发现全部修复达标、verify 证据逐字吻合、16 条 stories 落点完好；穷举复算后仍余 1 MAJOR + 2 MINOR + 2 NIT。

- **[MAJOR] demo.ts c3 行动影响「折合日均订单 +140」折算基数（日均访问 3.5 万）屏上不存在**——契约明列"行动预期影响"必须可复算（对照：c1 ¥1,400=5,000×0.28 ✓、c2 ¥1,300=600×2.1 ✓）。复核标准：四条 impact 每个数字可由同屏数据复算。
- **[MINOR] c3 标题「环比 -12%」舍入边界外**（对显示基线 3.2% 实为 -12.5%/-13%）。复核标准：(末值−前7日均值)/前7日均值 复算与标题一致。
- **[MINOR] demo.test 占比/环比断言为字符串字面量**，贡献漂移不报错。复核标准：由 breakdown 计算比值并与文本解析数字比较。
- **[NIT] App.css .status-btn 的 font-size 在 font 简写前，为死声明**，状态按钮字号与 .filter-chip 不一致。
- **[NIT] 'x' 格式 toFixed(1) 使图注 0.7 与标题 0.72 精度错位**。
- **[UNVERIFIED→作者确认] 贡献分解语义**：契约仅要求合计=偏离量，不要求按权重分解到维度值——作者确认。

## CONVERGE 分类（cycle 3）

- MAJOR（c3 影响基数）+ MINOR（-12.5%、测试复算化）+ 2 NIT（CSS 顺序、x 精度）：全部随修——均为小改且同族收尾。
- review_cycles: 2 → 3（最后一轮），→ IMPLEMENT → VERIFY → REVIEW cycle 4。

---

# REVIEW Findings — M1 决策看板（cycle 4，终审）

**VERDICT: PASS** — 两轴均通过：数字自洽契约四类（均值基线/连续天数/归因占比/行动影响）node 逐项复算全部自洽；三轮 12 项历史发现全部按复核标准修复到位；verify 证据独立重跑逐字吻合（exit 0、33/33、仅既定 echarts 警告）。仅余 1 MINOR + 2 NIT，均不构成阻断：

- [MINOR] 归因表「变化」列基数未声明且部分行不可复算（c3 直播端 +6% 可被同表模式推翻；c1/c2 隐含基数不在屏上）——在契约枚举四类之外。**处置：记录为 M2 打磨项**（需组件支持表级基数声明，避免无审查内容改动）。
- [NIT] tokens.css `--queue` 基色零直接引用。**处置：保留**——tokens.css 是 DESIGN.md 调色板的完整镜像，-ink/-soft/-line 均由它派生命名，保留全集是有意为之。
- [NIT] demo.test 三行常量对常量断言恒真。**处置：按复核标准替换为"操作数在屏"断言**（本 flow 自有测试代码的噪声清理，行为零变化）。

## CONVERGE（cycle 4）

无阻断发现 → SHIP。
