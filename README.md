# decision-platform · 决策看板

报告驱动的**行动闭环**：把已成文的数据分析报告（`.md`/`.txt`）放进目录，LLM 自动提取决策建议行动项（带报告原文引用、四级证据等级、由证据派生的置信度），人在看板或飞书审批卡片上确认（采纳/驳回必填理由）、采纳项拆解任务（负责人/截止日/状态）、执行后回录反馈（结果/指标变化/复盘/评分）——决策、执行、效果形成可追溯的资产。验收标准：每条行动项 30 秒内能判断靠不靠谱。

M1–M4 的「会员周报 CSV → 规则引擎 → 异动结论」管线已随 M5 退役（旧 CSV 留在 `data/raw/` 不再读取）。

## 使用

1. **放报告**：把分析报告（`.md`/`.txt`，UTF-8）放进 `data/raw/`。报告身份 = 文件名；约 1 分钟内（调度周期 60s）自动抽取，看板左栏出现报告项（状态点：待抽取/抽取中/已抽取/抽取失败）。
2. **看行动项**：主区按状态/证据等级/优先级/报告四维过滤；展开卡片查证据——报告原文逐字引用（四级色标：数据支撑=绿/多源佐证=蓝/逻辑推断=琥珀/经验假设=灰）、推导过程、预期效果。置信度由证据派生（证据等级 + 原文引用决定），非模型自评。
3. **确认**：看板「采纳」直接落库；「驳回」必填理由（≥2 字弹窗）。飞书渠道驳回落默认理由「卡片驳回（未填理由）」，看板详情区可补填一次。
4. **拆任务**：已采纳卡内添加任务（标题必填，负责人/截止日/优先级/备注可选），状态 待办→进行→完成。
5. **回录反馈**：每任务一条反馈（已执行/结果/指标变化/复盘/评分 1–5），已回录可「更新反馈」同端点覆盖。
6. **人工补充**：过滤器区「补充建议」可录入报告外建议（证据固定「经验假设」、置信度显示「人工」徽标），与抽取项同权走闭环。
7. **校准**：驳回理由与人工补充会注入后续抽取 prompt（G12，≤10 条近期数据；无数据不注入），后端行为，无界面。

`data/raw/` 无报告时看板显示演示数据（固定 3 条样例，操作不落库）；有报告但未配置模型密钥时显示明确错误态（不冒充演示）。

## 飞书卡片直审（M4 机制保留，M5 审批对象改行动项）

`data/im.json` 配置飞书自建应用（`platforms: [{platform:"feishu", appId, appSecret, approverUserId, approverName}]`）。新报告抽取完成后自动向审批人单聊推送：文本摘要（本周报告 N 份 · 建议 X / 已采纳 Y / 已驳回 Z / 人工补充 M）+ **高优卡片**（`priority=high` 或证据级「数据支撑」的建议项逐条：标题 + 依据 + 证据摘要（报告原文引用 + 等级 + 置信度）+ 预期效果 + 【采纳】【驳回】）。

- 手机单键直审即落库（decidedVia=card，留痕同步看板）；重复点击幂等（「已按首次点击结果处理」）；过期卡片回执提示到看板查看。
- 推送幂等：每报告 slug 只推一轮（`data/notify-state.json` 的 `pushedSlugs` 集合）；失败报告不推，抽取恢复后自动补推。
- 降级：未配置飞书时回落 `data/notify.json` 群机器人 webhook 文本摘要（`feishu|dingtalk|wecom|generic`）。
- 手动补救：`POST /api/notify/push`（body 可带 `slug` 定向重推）、`POST /api/notify/test`。
- 长连接（零公网入站）+ 内网单实例即可用；真实全链路验证脚本 `npx tsx scripts/e2e-feishu.ts`。

## SDK 接入（pi-agent-runtime）

- 依赖为 vendored `file:vendor/pi-agent-runtime-0.4.1.tgz`；业务代码唯一触点是 `server/agent/`（compose.ts 装配、extract.ts 经 `runWorker` 单次结构化抽取、normalize.ts 为 validate 纯函数）。
- 模型链：主 MiniMax-M3（anthropic-messages）+ 备小米 mimo-v2.6-flash（openai-completions）；密钥环境变量优先，缺省读 `~/.pi/agent/auth.json`；缺密钥降级不阻塞启动（抽取端点 503，看板其余能力可用）。
- 任务账本（权威预算，累计不封顶、重启不清账）：`data/agent-ledger.json`（+ `.audit.jsonl` 自审计）；运行详情抽屉的「任务账本用量」chips 即其 `usageTotals()` 投影（`GET /api/agent/usage`）。
- 审计：`data/agent-audit.jsonl`（SDK 安全元数据 JSONL，无 prompt/回复原文）；「抽取事件」时间线即其尾部投影（`GET /api/agent/events`）。
- 单次保护参数：输入裁剪 16k 字符、maxOutputTokens 8192、modelTimeoutMs 120s；离线测试用 `pi-agent-runtime/testing` 合成回放 transport。

## 开发

```bash
npm run verify   # tsc + vitest + build 三重门（提交前必跑）
npm run test     # 仅测试
npm run dev      # 仅前端（5180，/api 代理到 8642）
npm run server   # 仅后端（8642）
npm run dev:all  # 前后端一键（启动决策看板.command 同款）
npm run prod     # 前端构建 + 后端静态服务（生产形态）
```

## 结构

- `src/` 看板前端（React+Vite+TS，无 UI 框架）：三栏工作台（左栏报告导航 / 主区概览头+报告状态条+过滤器+行动项卡片流 / 右栏运行详情抽屉），Xanthil 视觉基线（token/卡片/焦点环）。
- `server/` 后端（node:http + tsx，SQLite `node:sqlite`）：`agent/` SDK 适配层、`db.ts` 四表存储（reports/action_items/action_tasks/action_feedback）、`reports.ts` 报告扫描与抽取管线（G3 force 重抽、G12 校准注入）、`board.ts` BoardView 聚合与行动闭环规则（G10/G11）、`notify.ts` 推送漏斗、`im.ts`/`im-feishu.ts` 飞书卡片直审。
- `data/raw/` 报告导入目录（`.md`/`.txt`）；`data/board.db` 行动闭环库。
- `docs/` 走查与验收记录；`.flow/` dev-flow 流程档案。

## 部署（M4 起不变：Mac mini 单实例 launchd 常驻）

```bash
cp scripts/com.decision-platform.prod.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.decision-platform.prod.plist
```

- 生产端口 **9642**（`HOST=0.0.0.0` 局域网可访问，仅限可信内网，禁止暴露公网）；开发端口 前端 5180 / 后端 8642。
- 日志 `data/prod.log`；重启自动恢复（RunAtLoad + KeepAlive）。
- **不入库**（双机各自独立）：`data/board.db`、`data/agent-ledger.json*`、`data/agent-audit.jsonl`、`data/notify.json`、`data/notify-state.json`、`data/im.json`、`data/prod.log`。
- 双机约定：Mac mini = 生产单实例（唯一事实源）；MacBook = 纯开发机，要看真实数据访问 Mac mini 实例。

## 路线

- **M1（已交付）**：看板形态 + 演示数据。
- **M2（已交付）**：会员周报 CSV 真实数据 → 异动检测 + 归因。
- **M3（已交付）**：webhook 推送（幂等）、行动持久化、跨周对照。
- **M4（已交付）**：飞书卡片直审 + 内网单实例常驻。
- **M5（当前，已交付）**：报告驱动行动闭环——LLM 抽取（证据/置信度/校准注入）、SQLite 四表存储、看板工作台三栏重写（行动项/任务/反馈/驳回弹窗/人工补充）、推送漏斗（按报告幂等 + 高优卡片）、运行详情抽屉。CSV/规则引擎/多周趋势管线退役。
- **候选**：钉钉适配（schema 预留）、桥接失败自动重建、多审批人（或签/会签）、公网升级 + IM 内 H5。
