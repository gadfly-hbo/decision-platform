# decision-platform · 决策看板

**项目化的行动闭环看板**：新建项目 → 项目内上传分析报告（`.md`/`.txt`/`.csv`/`.pdf`/`.docx`/`.doc`/`.pptx`/`.xlsx`/图片，服务端统一转文本）→ agent 自动抽取决策建议行动项（报告原文引用、四级证据等级、由证据派生的置信度）→ 看板或飞书卡片确认（采纳 / 驳回必填理由）→ 采纳项拆任务（负责人/截止日/状态）→ 执行后回录反馈（结果/指标变化/复盘/评分）。驳回理由与人工补充会作为 teach 信号校准本项目的后续抽取（项目级隔离，不串项目）。验收标准：每条行动项 30 秒内能判断靠不靠谱。

M1–M4 的「会员周报 CSV → 规则引擎 → 异动结论」管线与 M5 的「全局目录放报告 → 唯一看板」形态已随 M6 退役（旧 CSV 文件留在磁盘不读取）。

## 使用

1. **新建项目**：左栏「＋ 新建项目」（名称必填/目的可选），或首启引导卡。项目是根容器——每个业务/主题一个看板；当前项目记忆在浏览器（刷新回到最后项目）；**删除项目 = 硬删**（确认弹窗明示「项目及其报告文件将一并删除，不可恢复」，库内数据与报告文件一并清除）。
2. **上传报告**：项目内「上传报告」按钮（多文件，格式 `.md`/`.txt`/`.csv`/`.pdf`/`.docx`/`.doc`/`.pptx`/`.xlsx`/图片 png/jpg/jpeg/webp/gif，单文件 ≤20MB；文本类要求 UTF-8；Office/PDF 服务端解析文本层，PDF 页面与文档内嵌图片直送视觉模型识别——主模型 MiniMax-M3 原生多模态）。**上传即触发抽取**（无需手动再点），报告列表实时呈现状态：待抽取 → 抽取中 → 已抽取 / 抽取失败（可重试）。**同名上传 = 覆盖并重新生成**（仍处「建议」的抽取项删除重建；已采纳/已驳回/含任务项保留）——同名即"更新这份报告"，不弹重名确认。
3. **看行动项**：主区按状态/证据等级/优先级/报告四维过滤；展开卡片查证据——报告原文逐字引用（四级色标：数据支撑=绿/多源佐证=蓝/逻辑推断=琥珀/经验假设=灰）、推导过程、预期效果。置信度由证据派生，非模型自评。
4. **确认**：看板「采纳」直接落库；「驳回」必填理由（≥2 字弹窗）。改判单向：已采纳可改驳回，已驳回不可直接恢复（走重新生成或人工补充）。
5. **拆任务 / 回录反馈**：已采纳卡内添加任务（标题必填，负责人/截止日/优先级/备注可选），状态 待办→进行→完成；每任务一条反馈（已执行/结果/指标变化/复盘/评分 1–5），可「更新反馈」覆盖。
6. **人工补充**：过滤器区「补充建议」录入报告外建议（证据固定「经验假设」、显示「人工」徽标），与抽取项同权走闭环。
7. **校准（teach，无界面）**：本项目历史驳回理由（≤10 条）与人工补充（≤10 条）注入后续抽取 prompt——B 项目的信号不进 A 项目。
8. **运行详情**：概览头右侧「运行详情」抽屉（非模态）——模型链（主/备+密钥就绪）、任务账本用量（模型调用/token 入出/用时）、抽取事件时间线。账本是全局的，无项目时也可查看。
9. **会议汇报模式**：概览头「汇报模式」按钮或快捷键 `P` 进入全屏汇报流（Esc 退出，焦点回入口）——
   - **汇总页**：项目名 + 大字统计（报告/建议/高优/已采纳）+ 证据分布条 + 议程清单（优先级>置信度排序，点击直达）；范围可切「待拍板/全部」。
   - **逐项页**：单条一屏 3 米可读（标题/证据四色标+置信度大数字/报告原文引用/预期效果）；键盘 `←/→` 翻条、`Home/End` 首末、`G` 回汇总、`A` 采纳、`D` 驳回（大字弹窗，Esc 只关弹窗）。
   - **会中拍板**：采纳/驳回当场留痕（与看板、飞书卡片同库同先到先得语义），操作后 800ms 自动进下一条；已决项显示留痕行。

无项目时主区显示引导卡（不是演示数据）；模型密钥未配置时显示明确错误条且上传后的报告转「抽取失败：模型不可用」。

## 飞书卡片直审

`data/im.json` 配置飞书自建应用（`platforms: [{platform:"feishu", appId, appSecret, approverUserId, approverName}]`）。**抽取完成后事件驱动推送**（无定时扫描）：本项目摘要（`【项目名】`+ 行动闭环摘要）+ 高优卡片（`priority=high` 或证据级「数据支撑」的建议逐条：标题 + 依据 + 证据摘要（原文引用+等级+置信度）+ 预期效果 + 【采纳】【驳回】）。

- 手机单键直审即落库（decidedVia=card，看板同步留痕）；重复点击幂等；卡片驳回理由为默认值，看板可补填一次。
- 推送幂等键 = `projectId:slug`（每份报告每轮只推一次）；手动补救 `POST /api/notify/push`（body 可带 `projectId`/`slug` 定向）、`POST /api/notify/test`。
- 降级：未配置飞书回落 `data/notify.json` 群机器人 webhook 文本摘要（`feishu|dingtalk|wecom|generic`）。
- 长连接（零公网入站）+ 内网单实例即可用；真机全链路脚本 `npx tsx scripts/e2e-feishu.ts`（项目创建→上传→抽取→推送→卡片回调，隔离 tmp 数据）。

## SDK 接入（pi-agent-runtime）

- 依赖为 vendored `file:vendor/pi-agent-runtime-0.4.1.tgz`；业务代码唯一触点是 `server/agent/`（compose.ts 装配、extract.ts 经 `runWorker` 单次结构化抽取、normalize.ts 为 validate 纯函数）。
- 模型链：主 MiniMax-M3（anthropic-messages）+ 备小米 mimo-v2.6-flash（openai-completions，主模型故障自动切换）；密钥环境变量优先，缺省读 `~/.pi/agent/auth.json`；缺密钥降级不阻塞启动。
- 任务账本（权威预算，累计不封顶、重启不清账）：`data/agent-ledger.json`（+ `.audit.jsonl` 自审计）；「运行详情」的用量 chips 即其投影（`GET /api/agent/usage`）。
- 审计：`data/agent-audit.jsonl`（SDK 安全元数据，无 prompt/回复原文）；「抽取事件」时间线即其投影（`GET /api/agent/events`）。
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

- `src/` 看板前端（React+Vite+TS，无 UI 框架）：三栏工作台（左栏项目导航 / 主区项目概览+报告区+过滤器+行动项卡片流 / 右栏运行详情抽屉），Xanthil 视觉基线。
- `server/` 后端（node:http + tsx，SQLite `node:sqlite` 共享单库）：
  - `agent/` SDK 适配层（模型链/账本/审计/抽取 runner/归一化）
  - `db.ts` 五表存储（projects / reports / action_items / action_tasks / action_feedback，外键级联；M5 旧库自动删文件重建）
  - `reports.ts` 项目报告管线（上传注册/抽取状态机/force 重新生成/G12 项目级校准）
  - `board.ts` BoardView 聚合与行动闭环规则（G10 驳回理由/G11 人工补充）
  - `index.ts` 路由（项目 CRUD/上传/抽取/board/行动闭环/推送/账本投影）
  - `notify.ts` 推送原语（摘要/幂等键/事件驱动推送）、`im.ts`/`im-feishu.ts` 卡片直审
- 数据布局：`data/board.db`（库）、`data/projects/<projectId>/reports/<文件名>`（项目报告文件）、`data/agent-*`（账本/审计）、`data/notify*.json`/`data/im.json`（推送凭证）。
- `docs/` 走查与验收记录；`.flow/` dev-flow 流程档案。

## 部署（Mac mini 单实例 launchd 常驻）

```bash
cp scripts/com.decision-platform.prod.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.decision-platform.prod.plist
```

- 生产端口 **9642**（`HOST=0.0.0.0` 局域网可访问，仅限可信内网，禁止暴露公网）；开发端口 前端 5180 / 后端 8642。
- 环境变量：`PORT`/`HOST` 监听地址；`DATA_ROOT` 显式运行数据根（默认 `<项目根>/data`，覆盖 board.db、projects/、im.json、notify*.json、agent-* 全部运行数据；供宿主随包装配/容器部署定位数据，不设则与独立运行现状一致，见 `server/index.ts` `resolveDataRoot`）。
- 日志 `data/prod.log`；重启自动恢复（RunAtLoad + KeepAlive）。推送为抽取完成事件驱动，无常驻定时器，停机窗口不影响。
- **不入库**（双机各自独立）：`data/board.db`、`data/projects/`、`data/agent-ledger.json*`、`data/agent-audit.jsonl`、`data/notify.json`、`data/notify-state.json`、`data/im.json`、`data/prod.log`。
- 双机约定：Mac mini = 生产单实例（唯一事实源）；MacBook = 纯开发机，要看真实数据访问 Mac mini 实例。

## 路线

- **M1（已交付）**：看板形态 + 演示数据。
- **M2（已交付）**：会员周报 CSV 真实数据 → 异动检测 + 归因。
- **M3（已交付）**：webhook 推送（幂等）、行动持久化、跨周对照。
- **M4（已交付）**：飞书卡片直审 + 内网单实例常驻。
- **M5（已交付）**：报告驱动行动闭环——LLM 抽取（证据/置信度/校准注入）、SQLite 存储、三栏工作台前端、按报告推送。全局目录投放形态。
- **M6（已交付）**：项目化——项目为根容器（CRUD/硬删级联/统计导航）、项目内上传（base64/2MB/同名覆盖=重新生成）、上传即抽、事件驱动推送（调度器退役）、G12 校准项目级隔离、前端项目导航/无项目引导/演示态退役、旧库清空重建。
- **M7（已交付）**：会议汇报模式——全屏汇报流（汇总页大字统计+证据分布+议程直达、逐项页 3 米可读、键盘 `←/→` 逐条推进），会中拍板留痕与看板/飞书卡片同库同先到先得语义。
- **M8（已交付）**：抽取输出容错——`runText` 文本入口 + 宿主解析管线（围栏剥离/宽松修复/归一化校验不放松）+ 行动项 ≤6 条上限 + 解析失败自动修复重试一次（同 taskId 账本正常累计）。
- **M9（已交付）**：多格式报告摄入——PDF/Office/图片解析为文本+图像（pdfjs 逐页文本层+整页渲染、OOXML 解包、图片直送），PDF 页面与文档内嵌图像直送视觉模型（MiniMax-M3 原生多模态）。
- **M10（当前，已交付）**：JuanerAI 接入准备（插件侧）——`DATA_ROOT` 显式数据根（宿主装配不依赖 cwd 控制，缺省行为不变）、集成基线记录（`docs/juanerai-integration-baseline.md`：规范身份/物料指纹/宿主合同推荐默认）、路线文档同步；宿主侧 Adapter 未发生。
- **候选**：JuanerAI 对接（后续立项，不设占位）、钉钉适配（schema 预留）、桥接失败自动重建、多审批人（或签/会签）、公网升级 + IM 内 H5。
