# 提案：decision-platform 重构为报告驱动的行动闭环看板（M5）

日期：2026-10-12。来源：用户与 Agent 的重构讨论（本次会话），决策以用户原话为准。

## 用户原话（决策锚点）

> 我想你参考 pi-xanthil Actions 的方式进行重构，本质上我们的输入物就是报告，而不是数据，与 pi-xanthil Actions 一致的。
> 飞书卡片审核功能可以保留。其余都改成与 pi-xanthil Actions 一致。如果你有更好的优化点也可以放进来。
> -----
> pi-sdk 接入采用 pi-agent-runtime 0.4.1
> 开发流程调用 dev-flow

## 已确认的决策（约束，后续阶段不得推翻）

1. **输入物换成报告**：产品输入是已输出的数据分析报告（文本），不再是会员周报 CSV 原始数据。现有「CSV 解析 → 规则引擎 → 结论」管线整体退役。
2. **对齐 pi-xanthil Actions 模式**，完整闭环四段：
   - **生成决策建议**：LLM 从报告抽取行动项（title / rationale / scene / lifecycle / expectedImpact / priority / effort / 结构化 evidence：facts 带报告原文逐字引用、四级证据等级、reasoning；confidence 由证据确定性派生，忽略 LLM 自评）。
   - **确认行动**：行动项状态机 suggested → adopted / dismissed。
   - **执行**：行动项下拆任务（owner / dueDate / status / priority / note）。
   - **执行后反馈**：每任务一条反馈（adopted / outcome / metricDelta / review / score）。
3. **飞书卡片审批保留**：现有 M4 移动审批（长连接、卡片直审、幂等、留痕）保留，审批对象改为新行动项（采纳/驳回映射 adopted/dismissed）。
4. **LLM 接入用 pi-agent-runtime 0.4.1 SDK**（不是 pi-xanthil 的 pi CLI 子进程方式）：结构化抽取任务用 `runWorker`（无工具单次模型调用 + 宿主 validator），遵守 AGENT-RUNTIME.md 接入标准（显式模型/transport/密钥、授权回调、BudgetStore 任务账本、AuditSink 审计、输出按 schema 校验）。
5. **开发流程走 dev-flow**（本流程）。

## 允许的优化点（用户明示授权「更好的优化点也可以放进来」，需在 PRD 中列明）

- 候选（调查已支持，PRD/GRILL 定案）：报告放入目录后自动检测 → 抽取 → 推送（复用现有幂等推送调度器思路）；行动项/任务/反馈用 SQLite（node:sqlite）替换 data/*.json；报告身份与去重键；飞书卡片带证据摘要。

## 被否决的方案（不再讨论）

- 保留 CSV 数据管线与规则引擎作为并行输入源（与「输入物就是报告」冲突）。
- 直接复制 pi-xanthil 的 pi CLI 子进程接法（用户指定 pi-agent-runtime 0.4.1）。
- 黄金策（Golden Strategy）式框架图生成（用户明确「不对，不是这个黄金策」）。

## 调查结论（方案依据，已核实）

- pi-xanthil Actions 实现：`server/src/routes/viz.ts:691-870`（extract 端点 + prompt 约束 + parseActionDraftsFromLlm/parseActionEvidence/deriveActionConfidence）、`server/src/db/viz.ts:78-123`（action_items/action_tasks/action_feedback 三表）、前端 `web/src/components/ActionsPane.tsx`（证据四级色标、过滤、任务/反馈 UI）。
- pi-agent-runtime 0.4.1：`createRuntime({model, transport, authorize, audit, budgets})` → `runWorker<T>({validate})`；宿主需 ModelConfig+createPiTransport（显式 apiKey）、Authorization、AuditSink（append 即持久确认）、BudgetStore（同任务唯一 lease）。参考采用：`reports-factory`（`file:vendor/pi-agent-runtime-0.4.1.tgz`，model.ts / audit.ts / authorize.ts / budget-store.ts，密钥读 `~/.pi/agent/auth.json`，MiniMax-M3 主 + mimo-v2.6-flash 备）。
- 本仓库现状：M1-M4 已交付（README 路线）；后端 node:http + tsx，前端 React+Vite+ECharts；飞书长连接桥 `server/im-feishu.ts`；推送调度 `server/notify.ts`；行动存储 data/actions.json；测试 vitest，`npm run verify` 三重门。

## 未决问题（GRILL 填补，不得与上面冲突）

- 报告来源目录与格式约定（沿用 data/raw/ 改放 md/txt？）与报告身份键。
- 存储选型（SQLite vs JSON 文件）及现有 data/actions.json 历史数据处理。
- 前端形态：现有结论看板组件（ConclusionCard/DerivationChain 等）去留与替换范围。
- 模型主备链与单次保护参数（预算、超时、输出上限）取值。
- 现有 webhook 文本推送（notify.ts）与新卡片推送的关系。
- 演示数据回退（isDemo）是否保留。
