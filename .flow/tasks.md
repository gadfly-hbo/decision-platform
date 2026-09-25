# 任务拆解 · 决策看板 M1

> 来源：`.flow/prd.md`；拆解自批准（dev-flow ISSUES 阶段，2026-09-25）。无 issue tracker，落盘 `.flow/tasks.md`。

- [x] 1. 脚手架与验证基线
- [x] 2. 数据层契约与演示数据（含双域走查）
- [x] 3. 结论区 tracer bullet
- [x] 4. 证据区四块（推导链路/指标图/归因表/行动）
- [x] 5. 行动汇总区与收尾走查

---

## 1. 脚手架与验证基线

### What to build
项目地基（prefactoring 切片）：手工 Vite + React + TypeScript 脚手架、Vitest + Testing Library 测试基建、`npm run verify` 三重门命令、git 基线（init + .gitignore + .flow artifacts 提交）。完成后 `npm run verify` 全绿（含一个最小冒烟测试：应用外壳可渲染出产品句）。

### Acceptance criteria
- [ ] `npm run verify`（tsc --noEmit && vitest run && vite build）本地一次通过
- [ ] 存在最小冒烟测试：渲染 App 外壳，断言产品说明句可见
- [ ] git 仓库已初始化，基线提交包含 .flow durable artifacts，`.flow/state.json` 被 gitignore
- [ ] 依赖仅限：react/react-dom/echarts + vite 系/测试系（无 UI 组件库、无 CSS 框架、无日期库）

### Blocked by
None - can start immediately

---

## 2. 数据层契约与演示数据（含双域走查）

### What to build
看板的唯一数据事实源：类型化数据模块，导出指标定义（id/名称/单位/口径/格式化）、指标序列（含基准线）、结论（严重度/标题句/摘要/数据窗口/推导步骤/指标引用/归因明细/建议行动）。演示数据为线上经营·渠道投放域：4 条结论覆盖高/中/低严重度、14 天窗口、归因到渠道/计划两级。另附"电商经营"假想数据的映射走查记录（验证接口不贴合单一域，红队 KA3 缓解）。

### Acceptance criteria
- [ ] 类型契约覆盖 PRD Implementation Decisions 中的数据层契约，无 UI 内联业务数据
- [ ] 演示数据 4 条结论按严重度排序可验证（高→中→中→低）
- [ ] 每条结论的推导链路含 检测→归因→规则匹配→建议 四类步骤
- [ ] 归因明细按偏离贡献绝对值降序
- [ ] 双域走查记录落盘（.flow/ 或代码注释旁的 docs），电商域假想数据能映射进同一类型
- [ ] 数据层行为测试通过（排序/格式化/口径引用一致性）

### Blocked by
- 1（需要测试基建）

---

## 3. 结论区 tracer bullet

### What to build
第一条纵切弹道：概览头（产品句/数据窗口/更新时间）+ 结论区列表（严重度 chip 色+文字双通道、一句话摘要、数据窗口标注），结论卡可展开/收起，默认展开第一条（最高严重度），可多开。展开态先给骨架（占位四块结构），切片 4 再填实。

### Acceptance criteria
- [ ] 打开页面 30 秒内可扫读全部结论标题与严重度（user story 1/2/3）
- [ ] 严重度 chip 同时有语义色与文字（Xanthil 双通道，story 15）
- [ ] 默认展开第一条，其余收起；点击切换，可多开（GRILL 决议 4）
- [ ] 概览头含产品说明句、数据窗口与更新时间（story 9/13）
- [ ] 渲染测试：断言排序、chip 文字、展开交互

### Blocked by
- 2

---

## 4. 证据区四块（推导链路/指标图/归因表/行动）

### What to build
结论展开态填实四块：① 推导链路有序步骤（检测→归因→规则匹配→建议，带编号）；② 核心指标 ECharts 折线图（14 天序列 + 基准/阈值标线，薄封装 init/update/dispose/resize）；③ 归因明细表（按偏离贡献降序，正负偏离可区分）；④ 建议行动（动作 + 预期影响 + 待定/采纳/驳回状态标记，状态提升到应用层）。

### Acceptance criteria
- [ ] 展开即见完整推导链路，步骤类型可辨识（story 4）
- [ ] 指标图渲染折线与基准线（测试 stub canvas，断言 option 关键结构：序列与 markLine，story 5）
- [ ] 归因表按贡献降序、偏离方向语义色（story 6）
- [ ] 行动可切换状态且状态变化在 UI 双通道可见（story 7/8）
- [ ] 图表容器随窗口 resize（薄封装验证）

### Blocked by
- 3

---

## 5. 行动汇总区与收尾走查

### What to build
页面收尾：行动汇总区（聚合全部建议行动 + 状态计数与过滤）+ 数据缺失空状态（接口预留）+ ≤900px 响应式单列 + Xanthil token 全量对齐走查（色彩对/排版档位/圆角/间距/焦点环）+ 对照 PRD user stories 的最终人工走查（30 秒标准）。

### Acceptance criteria
- [ ] 行动汇总区展示全部行动与状态，与结论卡内状态联动一致（story 8）
- [ ] 空数据时显示明确空状态而非白屏（story 14，接口预留）
- [ ] ≤900px 单列可用，无横向溢出（story 16）
- [ ] Xanthil 走查清单留档（token 对照，逐项核对）
- [ ] `npm run verify` 全绿；PRD 16 条 user stories 逐条对照有落点

### Blocked by
- 4
