# PRD：decision-platform M7 — 会议汇报模式

合成自 `.flow/proposal.md`（含四点确认）+ 红队 + M6 现状。纯前端特性，无后端变更。

## Problem Statement

会议投影场景下，工作台的操作密度（15px 正文、三栏、编辑表单）不可读也不符合汇报叙事：开场要一眼看到"要拍板什么"，过会要逐条讲、现场核查证据、当场拍板。

## Solution

独立**汇报模式**：一键进入的全屏汇报流视图——汇总页（大字统计+议程）→ 逐项页（单条一屏、3 米可读、键盘推进）→ 会中采纳/驳回（留痕同库）→ Esc 退出回工作台。亮色放大版，沿用 Xanthil 基线与四色证据标。

## User Stories

1. As a 会议主持人, I want 一键进入汇报模式并全屏呈现, so that 投影即开讲。
2. As a 会议主持人, I want 开场汇总页大字统计与高优议程, so that 一句话说明今天拍什么。
3. As a 会议主持人, I want 键盘 ←/→ 逐条推进行动项, so that 像放幻灯片一样过会。
4. As a 参会人, I want 每条大字号呈现标题/证据等级/置信度/原文引用/预期效果, so that 3 米外看得清。
5. As a 参会人, I want 有人质疑时当场看到报告原文引用, so that 证据现场可核查。
6. As a 决策人, I want 会中直接点采纳/驳回（驳回带理由弹窗）, so that 拍板当场留痕。
7. As a 决策人, I want 操作后自动进下一条, so that 会议流不中断。
8. As a 会议主持人, I want 切换「全部」复盘已决项及其留痕, so that 会后核对决策记录。
9. As a 会议主持人, I want Esc 退出回工作台且焦点回到入口, so that 无缝续用操作台。

## Implementation Decisions

**入口与容器**
- 概览头（S1）新增「汇报模式」主级按钮；快捷键 `P`（在工作台主区、无输入焦点时）触发；浏览器全屏（Fullscreen API `requestFullscreen`，失败静默降级为 CSS 全屏占位——投影可接受降级，功能不依赖）。
- 汇报模式为覆盖层（fixed inset-0、z 高层、自身滚动禁用——单屏内容）；Esc 关闭（焦点回「汇报模式」按钮）；打开时焦点入模式容器。

**汇总页（首页）**
- 项目名（+purpose）+ 大字统计行：`报告 N · 建议 X · 高优 Y · 已采纳 Z`（数字 ~64px，标签 0.9rem）。
- 证据分布条：一根横向堆叠条（四色 = 四级证据，宽度按条数占比；0 条等级时并入灰段），下方四色图例带计数。
- 议程清单：默认范围（待拍板）内按 优先级>置信度 排序的行式列表（序号 + 标题 + 优先级徽标 + 证据色点）；点击任意行直达该逐项页。
- 底部提示行：`← → 切换 · Esc 退出`。

**逐项页（主体）**
- 单条一屏（100dvh 内自适应；内容超长时仅引用块内部滚动）。
- 信息结构固定自上而下：页码指示（`3 / 8` + 范围标签「待拍板/全部」）；行动项标题（~clamp(28px, 4vw, 44px)）；徽标行（优先级/投入/场景·周期值 chip，大号）；证据区（四色标 + 置信度大数字 ~56px + 报告原文引用 blockquote ~24px + 推导过程收起可展开）；预期效果行；来源行（报告文件名）。
- 键盘：`←/→` 上一条/下一条、`Home/End` 首末、`A` 采纳、`D` 驳回（打开弹窗）、`G` 汇总页；按钮同功能可点。
- **会中拍板**：大号 采纳（主绿）/ 驳回（fail 色）按钮；采纳 → PATCH adopted → 留痕行浮现（审批渠道=看板）→ 800ms 后自动前进；驳回 → 大字号驳回理由弹窗（复用 G10 规则：必填 ≥2 字、Esc 关弹窗不退模式——**弹窗打开时 Esc 只关弹窗**，焦点管理同 S11）→ 成功后自动前进。
- 已决项（全部模式或操作后回看）：按钮区替换为留痕行（`已采纳 · 看板 · 10-13 14:22` / `已驳回 · 理由摘要`）。
- 人工项：置信度位显示「人工」大徽标，证据区固定说明（沿用工作台文案）。

**排序与范围**
- 待拍板：`status=suggested`，排序 key =（priority high>medium>low, confidence desc, createdAt asc）；全部 = 全状态同 key 排序在前加状态分组（suggested → adopted → dismissed）。
- 空范围（无待拍板项）进入：汇总页显示空议程文案`当前没有待拍板的建议`+「查看全部」切换；逐项页禁用。

**数据与留痕**
- 只读复用 BoardView（项目 board 已有全部字段）；操作走既有 PATCH /api/actions/:id（乐观更新本地副本 + 失败 role=alert 提示并停留当前页）；飞书先到先得语义不受影响（服务端幂等既有）。

**不做**
- 暗色版、打印/PDF 导出、演讲者备注、动画转场（仅轻量 fade 80ms 内）、后端任何变更。

## Testing Decisions

- 组件测试（注入 BoardView 缝）：入口按钮/快捷键 P 进入与 Esc 退出焦点返回；汇总页统计/分布条计数/议程排序与直达；逐项页信息结构完整性（四级证据各一夹具）、键盘 ←/→/Home/End/G、A 采纳调用与自动前进、D 弹窗（大字号版 G10 校验逐字文案/Esc 只关弹窗/成功前进）、已决项留痕行、空范围文案、人工项呈现。
- 回归：工作台用例零改动仍绿（模式是覆盖层不侵入工作台 DOM 语义）。

## Out of Scope

暗色配色、导出/分享、多项目联播、动画丰富化。

## PRD 增量（auto 自批清单）

- 新增：快捷键 P/A/D/G 键位、Fullscreen API 降级策略、汇总页直达点击、800ms 自动前进、全部模式状态分组、空范围文案、引用块内部滚动约束。均纯新增，无 proposal 决策改变。

## GRILL 决议（2026-10-13，2 轮收敛）

- **G1'' Esc 语义**：弹窗打开时 Esc 只关弹窗（焦点回驳回钮）；无弹窗时 Esc 退模式。两层不冲突，钉死。
- **G2'' 空态**：无待拍板 → 汇总页空议程 + 引导切「全部」；不阻止进入模式（复盘场景仍可用）。
- **G3'' 已决项呈现**：按钮区替换留痕行（渠道/时间/驳回理由摘要一行，超长省略号，完整理由在工作台看）。
- **G4''（第 2 轮）分发一致性**：工作台与汇报模式对同一行动项的操作共享 useBoardStore 同一方法（不复制请求逻辑），模式内本地乐观副本 + 失败停留。

---

# PRD：M8 抽取输出容错（合成自 proposal，增量纯新增）

- `server/agent/normalize.ts` 增纯函数：`extractJsonArrayText`（剥 ```json 围栏 + 字符串感知的中括号配对提取，移植 pi-xanthil 已验证实现）、`repairLooseJson`（字符串感知剥离 // 与 /* */ 注释、尾逗号）、`parseDraftsFromText(text)`（extract → parse → repair 重试 → validateActionDrafts，全失败抛错）。
- `server/agent/extract.ts`：`runExtractionRaw` 改 `runtime.runText`（同 limits/modelRecovery）；`runExtraction` 成功后 `parseDraftsFromText`；解析失败 → 同 taskId 追加修复指令（「上次输出无法解析为 JSON 数组。只输出严格 JSON 数组，不要任何其他文字、解释或代码围栏」）再跑一次 runText；仍失败抛「抽取失败（输出不是合法 JSON 数组）」。
- SYSTEM_PROMPT 增：「提取的行动项数量控制在 6 条以内（报告信息不足以支撑 6 条时更少）——只输出优先级最高的行动项」。
- 测试：normalize 纯函数（围栏/说明文字/字符串内 ]/注释/尾逗号/截断失败）；extract（围栏回复成功[原失败用例翻转]、说明文字包裹成功、截断 JSON→修复重试成功断言重试 prompt、两次皆败抛错）；账本 taskId 复用不炸（同任务两次 run）。
- G 决议：重试与首轮共用 taskId 与 configuration（账本 CONFIGURATION_CHANGED 不触发）；重试上限 1 次；REPORT_CLIP 16k 不变。

---

# PRD：M10 JuanerAI 接入准备·插件侧（合成自 proposal + 红队吸收项）

## Problem Statement

宿主（JuanerAI）随包装配需要显式数据根，现状为 `<cwd>/data` 隐式耦合：直接进程形态下宿主必须控制工作目录才能定位数据；集成身份（源提交／固定物料指纹）未落档，未来宿主按规范 §6 建立升级基线时无处可查；README 路线节与 git 历史漂移（停在 M6，实际已交付至 M9）。

## Solution

三项插件侧准备：`DATA_ROOT` 环境变量显式数据根（boot 块统一派生六类运行数据路径）；`docs/juanerai-integration-baseline.md` 集成基线记录（规范身份 + 物料指纹 + 宿主三项推荐默认 + 未采用声明）；README 路线节补 M7–M10 与 `DATA_ROOT` 文档。

## Implementation Decisions

**DATA_ROOT（接缝设计）**
- `server/index.ts` 新增导出纯函数 `resolveDataRoot(env = process.env, cwd = process.cwd()): string`：`DATA_ROOT` 未设或空白 → `join(cwd, 'data')`；否则 `resolve(cwd, raw)`（相对路径按 cwd 钉死、绝对原样）。
- 直接执行入口（main-module 守卫内）改为：`const dataRoot = resolveDataRoot()`，全部运行数据路径从 `dataRoot` 派生并**显式传入** `startServer`：`db`（`join(dataRoot,'board.db')`）、`projectsDir`、`notifyFile`、`notifyStateFile`、`agentAuditPath`（恒传，替代原 composed 成功才传的条件展开——两者路径恒等）、`im.json` 读取与 `composeDefaultAgent(dataRoot)` 同根。
- 库函数 `startServer` 及 `ServerOptions` **零改动**：显式 options 优先的既有设计不变，`DATA_ROOT` 不进库函数（测试/宿主库形态仍走注入）。
- 独立运行零变化：不设 env 时所有路径与现状逐字节等价。
- `dist/` 静态资源目录不受 `DATA_ROOT` 影响（代码资源 ≠ 用户数据）。

**集成基线记录 `docs/juanerai-integration-baseline.md`**
- 规范身份：PR #93、提交 `6756546a1423162b16a552b24b83bdaa1e834e50`、散件包 tar.gz SHA256 `7407719118b481f5786a6bd2dfda2611c67625cbdda9da414d2563c7ceaba50a`（19,778 bytes）；注明「摘要一致证明内容一致，不等于签名/认证/实现符合」。
- 插件物料指纹：业务源提交（M10 发布提交，采用时以实际采用提交为准）、vendored `pi-agent-runtime-0.4.1.tgz` SHA256 `1ddace3a5b7ff97e80627dc4660d9f300ac402a4bfc67f43144380d3352d6da5`（102,550 bytes）、`package-lock.json` SHA256（落档当时值，采用时重算）。
- 宿主三项合同决策（推荐默认，**待宿主任务正式确认**）：承载形态＝子进程+HTTP（`/api/health` 就绪探针）；UI＝反代同源整屏（前端零基址硬编码）；密钥＝宿主 env 注入（`server/agent/model.ts:17-31` env 优先不被覆盖）。
- 显式声明：宿主侧 Adapter/装配**未发生**；本文是记录不是采用证明；首次采用时按 standard §6 建立最小差异表，升级保护「不能证明保留已验行为 → 阻止该次新升级并保留旧包」。

**README**
- 「开发」节补环境变量说明：`DATA_ROOT`（默认 `<cwd>/data`；含 board.db / projects / im.json / notify*.json / agent-*）。
- 「路线」节：M6 去掉「当前」标记；补 M7（会议汇报模式）、M8（抽取输出容错）、M9（多格式报告摄入）、M10（当前：JuanerAI 接入准备·插件侧）。

## Testing Decisions

- 新文件 `server/data-root.test.ts` 四用例：缺省 `<cwd>/data`；绝对路径原样；相对路径按 cwd 解析为绝对；空白字符串视为未设置。
- boot 块接线（main-module 守卫内）不做单测——与既有先例一致（启动装配从未直接单测），由 REVIEW 走查六类路径派生完整性（红队 R1）。
- 回归：全量 `npm run verify`（tsc + vitest + build）。

## Out of Scope

API 鉴权 hook、取消端点、plist 参数化、宿主侧任何装配/Adapter、SDK 升级或版本统一、`.flow/state.json` 入库（维持 gitignore）。

## GRILL 决议（2026-10-17，免轮）

范围三项与发布方式经用户显式确认（问答落档）；宿主三项合同决策按「推荐默认待确认」处理，无未决 load-bearing 假设，免 GRILL 轮。
