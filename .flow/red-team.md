# Red-Team：decision-platform 重构为报告驱动行动闭环看板

对 `.flow/proposal.md`（2026-10-12）的攻击性评估。

### Top Kill-Assumptions（按 影响×误判概率×可测成本 排序）

**1. 报告来源稳定存在（最高优先）**
- **Claim**：输入物是"已输出的数据分析报告"，且能持续获得。
- **Steelman**：用户同时经营 pi-xanthil（数据分析工厂，产出 md 报告）与本产品，两产品串联（xanthil 产报告 → 本产品出行动看板）是自然工作流；用户原话"本质上我们的输入物就是报告"表明对自己的工作流有清楚认知。
- **Fails if**：实际每周业务输入仍是结构化 CSV/数据表，"分析报告"只是偶尔产物——重构后看板无米下锅，退化成演示品。
- **Evidence to get this week**：确认报告物理来源——pi-xanthil 报告输出目录直接读取？人工导出 md 放入 `data/raw/`？取 1-2 份真实报告跑一次抽取看质量。
- **Kill criterion**：一个月内无法稳定获得 ≥2 份真实报告，或报告获取仍需等价于 CSV 导入的人工成本且无自动化路径。
- **Cheapest test**：手动放 1 份真实报告进新输入目录 → 触发抽取 → 人工评估行动项可用率。
- 判定：**go，但报告来源与目录约定是 GRILL 第一问**（proposal 留白，非矛盾）。

**2. runWorker 真实 Provider 调用获得授权且模型可用**
- **Claim**：pi-agent-runtime 0.4.1 `runWorker` + MiniMax-M3 可用于生产抽取。
- **Steelman**：reports-factory 同 SDK 同模型已真调验证（M3 写整页代码场景 maxOutput 32k 实测）；抽取任务比它轻（16k 输入、结构化输出）；标准允许"按实际启用用途有界验证"。
- **Fails if**：本产品真实 Provider 调用未获单独授权，或 `~/.pi/agent/auth.json` 密钥在部署机（Mac mini）不可用——抽取链路整体不可用，只剩演示数据。
- **Evidence to get this week**：检查 Mac mini 上密钥文件存在性；用户对真实调用的授权即本次重构委托本身（用户指定"接入采用 0.4.1"即意图真实使用）。
- **Kill criterion**：部署环境无密钥且无法配置；或 M3 对真实报告抽取的输出质量验收失败。
- **Cheapest test**：实现后用 1 份真实报告跑 runWorker 端到端。
- 判定：**go**（委托已含真实使用意图；实现中做有界真实验证）。

**3. LLM 抽取质量足以支撑"拍板"**
- **Claim**：从报告抽取的行动项可信到能直接采纳/驳回。
- **Steelman**：pi-xanthil Actions 已在生产迭代（confidence 公式冻结、证据四级降级、quote 逐字引用约束、两轮用户批准的增补），模式已过真实使用检验，不是实验室方案。
- **Fails if**：报告本身结论含糊（如黄金策输出那种框架化文本），抽取出的行动项全是"加强/关注/提升"类空话。
- **Kill criterion**：真实报告抽取的行动项中，可执行具体项占比 < 50% 且连续两份报告如此。
- **Cheapest test**：同 #1 的一次性抽取评估。
- 判定：**go**（模式已验证；质量风险由证据等级标签+人工确认环节兜底）。

**4. 飞书卡片审批映射到新状态机**
- **Claim**：M4 卡片直审可保留并适配 adopted/dismissed。
- **Fails if**：新行动项数量大（一份报告 5-10 条），逐条推卡片造成审批疲劳，移动审批形同虚设。
- **Kill criterion**：审批人在卡片上处理一条行动的平均意愿显著下降（用户主观反馈"卡太多"）。
- **Cheapest test**：首份真实报告推送后观察卡片数量与处理率；必要时收敛为"仅高优/高置信推卡片"。
- 判定：**go**（实现层优化点，不推翻架构）。

### What's Well-Reasoned

- **输入物转向报告**：用户对自家工作流判断明确，且 pi-xanthil Actions 模式有生产验证；proposal 把"否决方案"列清楚，避免了混合管线的复杂度陷阱。
- **runWorker 而非 pi CLI 子进程**：结构化抽取是标准里 Worker 的教科书场景（固定流程、机器消费、schema 校验）；reports-factory 提供了全套宿主基建参考（文件账本 272 行/JSONL 审计 23 行/授权 32 行），接入成本已被邻项目摊薄。
- **保留飞书审批**：M4 已解决的难题（长连接、幂等、留痕）不重造。

### What I Couldn't Assess

- 报告的具体形态（pi-xanthil 黄金策 HTML？md 报告？人工分析报告？）——影响抽取 prompt 的输入假设。
- 现有 data/actions.json 历史行动记录是否需要迁移。
- 单实例 Mac mini 部署下 SDK 任务账本与现有 launchd 形态的兼容细节。

## 结论

**verdict: go**。无 kill 准则已达成；#1（报告来源）作为最高优先 open question 进入 GRILL，#4 作为实现层优化点带入 PRD。
