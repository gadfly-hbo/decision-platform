# PRD · M4 移动审批：飞书+钉钉卡片直审（内网单实例）

> 事实源：`.flow/proposal.md`（v1.1 定稿）；对齐 `.flow/red-team.md`（GO，KA1-KA5）。项目无 issue tracker，落盘 `.flow/prd.md`（降级路径）。
>
> **2026-09-27 范围变更（用户决策）**：M4c 钉钉**暂缓**——前置门与适配器不做，M4 交付范围收窄为仅飞书；dingtalk 配置 schema 与平台无关纯函数层保留，钉钉适配列 M5+ 候选。KA5 文案密度用户真机判定「敢拍板」，无需加密信息密度。

## Problem Statement

决策人已经能在手机上收到周报摘要推送（M3 群机器人纯文本），但「拍板」必须回到 PC 打开看板操作——通勤、出差、会议间隙收到「高优先级 N 条待拍板」时只能记下来回办公室。此外，M3 的「自动推送」实际只在有人打开看板时才触发（`GET /api/dashboard` 内 fire-and-forget），而看板目前只在开发机上手动启动，既不稳定也存在「没人开看板 → 永不推送」的断链。

## Solution

决策人在自己常用的 IM（飞书/钉钉）里完成候选决策审批：每周周报导入后，每条高优结论自动推成一张**自解释的交互卡片**（结论标题 + 关键数字 + 结论全文 + 归因 top 渠道 + 【采纳】【驳回】按钮），点按钮即完成审批，卡片即时变为结果态并留痕「谁、何时、经何渠道批的」；PC 看板状态同步更新。服务以**内网 Mac mini 单实例常驻**（launchd 自启 + 静态文件服务 + 定时扫描推送），零公网入站（飞书长连接 / 钉钉 Stream 均为出站 WebSocket）。

## User Stories

1. As a 决策人, I want 周报导入后每条高优结论自动推送一张飞书/钉钉卡片, so that 不打开 PC 看板也知道本周要拍板什么。
2. As a 决策人, I want 卡片上有【采纳】【驳回】按钮, so that 30 秒内完成审批且不离开 IM。
3. As a 决策人, I want 卡片正文包含结论全文与归因 top 渠道, so that 不看完整推导链也敢负责任地拍板（红队 KA5）。
4. As a 决策人, I want 点完按钮后卡片立即变为结果态（审批人+时间+结果）, so that 不重复审批、事后可查。
5. As a 决策人, I want 重复点击或平台重试不会产生脏数据, so that 先到先得、后到提示已处理。
6. As a 决策人, I want 中低优结论仍收到文本周摘要, so that 不丢全量信息但只在手机上处理高优。
7. As a 决策人, I want 审批留痕（谁/何时/经卡片还是 PC）在看板上可见, so that 跨周对照时知道每条决策的来历。
8. As a 运营/分析, I want PC 看板照常显示行动状态并同步移动端审批结果, so that 闭环数据单一事实源。
9. As a 运营/分析, I want 未配置自建应用时推送降级为现有群机器人文本摘要, so that 现有使用不回归。
10. As a 用户, I want Mac mini 重启后服务与数据自动恢复（launchd 常驻）, so that 不需要人工干预。
11. As a 用户, I want 局域网内任意设备（MacBook/手机）浏览器直接打开看板（后端服务静态构建产物）, so that 不依赖 vite dev server。
12. As a 用户, I want 开发实例与生产实例并存互不干扰（端口区分）, so that MacBook/Mac mini 上仍可本地开发。
13. As a 用户, I want IM 应用凭证（appId/appSecret/审批人 id）集中在一个不入库的配置文件, so that 沿袭 notify.json 惯例、凭证不泄漏。
14. As a 用户, I want 飞书与钉钉配置可共存、按平台分别推送审批人, so that 两个 IM 的决策人都能收到卡片。
15. As a 用户, I want 周报导入后即使无人打开看板，卡片也在 1 分钟内自动发出（定时扫描新期次）, so that 移动审批不依赖任何人先访问看板（红队 KA1）。
16. As a 用户, I want 钉钉 Stream 若实测不支持卡片回调时自动降级为文本摘要, so that 不为一家平台引入公网暴露（proposal §8 预案）。
17. As a 用户, I want README 写清单实例部署、端口、睡眠设置与安全边界（仅可信局域网）, so that 双机模式切换有据可依。

## Implementation Decisions

**分期与范围**（proposal §7 定稿）：M4a 内网单实例地基 → M4b 飞书卡片直审 → M4c 钉钉卡片直审。M4 整体不含：IM 内 H5（档 2）、卡片备注输入、多审批人会签、原生审批中心（均 M5+ 候选）。

**M4a · 地基**

- 后端新增**静态文件服务**：存在构建产物 `dist/` 时同端口 serve（SPA fallback 到 index.html，`/api` 路径优先匹配 API）；无 `dist/` 时行为不变（本地开发走 vite）。
- **端口策略**：开发沿用前端 5180 / 后端 8642；生产由环境变量指定（`PORT` / `HOST`），launchd 配置固定生产端口 **9642**、绑定 `0.0.0.0`（可信局域网）。README 安全表述改写：仅可信局域网、禁止端口映射到公网。
- **常驻**：提供 launchd LaunchAgent plist 模板（RunOnLoad + KeepAlive）与部署说明；README 注明 Mac mini 节能设置（防止自动睡眠）。
- **审批留痕**：行动记录新增 `decidedBy`（审批人标识）、`decidedAt`（服务端时间）、`decidedVia`（`card` | `pc`）；状态回滚到 pending 时清空三者；PC 端现有 PUT 请求体不变（via 记 `pc`、decidedBy 留空），卡片回调走内部落库路径（via 记 `card`、decidedBy 为配置的审批人名）。
- **推送触发独立化**（红队 KA1）：服务进程内**定时扫描**（60 秒间隔）周报目录，发现新期次即走既有幂等推送（`maybePushNewPeriod` 语义）；看板访问触发的推送保留为兜底。扫描逻辑为纯函数（目录 → 最新期次），定时器只是薄封装。

**M4b/M4c · 卡片直审**

- **IM 配置**：`data/im.json`（不入库）：平台列表，每项 `{ platform: 'feishu'|'dingtalk', appId, appSecret, approverUserId, approverName }`；与既有 `notify.json`（群机器人文本降级）并存。
- **推送策略**：仅 **high 严重度**结论逐条发卡片（每条一张，带各自的【采纳】【驳回】）；medium/low 与期次汇总信息继续走文本摘要（群机器人或应用消息文本，取配置可用者）。无 high 结论的期次只发文本摘要。
- **卡片文案结构**（红队 KA5）：结论标题（含严重度）、关键数字（指标本期值与偏离）、结论 summary 全文、归因 top 3 渠道行（维度 + 贡献/变化）、按钮【采纳】【驳回】。纯函数生成卡片数据结构，平台适配器负责翻译成各平台卡片 schema。
- **审批回调**：按钮回调 → 按 actionId + 目标状态走既有行动状态机落库（幂等：已非 pending 时返回结果态文案而非报错）→ 决定者留痕 → 更新原卡片为结果态（「已采纳/已驳回 · 审批人 · 时间」）。回调处理为纯函数（回调载荷 + store → 新 store + 回执），SDK 网络层不进单测。
- **平台适配**：引入官方 Node SDK（飞书 `@larksuiteoapi/node-sdk` 长连接；钉钉官方 Stream SDK）；适配器接口统一（发卡、收回调、更新卡片），M4c 复用接口只新增钉钉实现。
- **前置门**（红队 KA2/KA4）：M4b 开工前飞书 demo 实测（内网发卡 + 收按钮回调 + 更新卡片）通过；M4c 开工前钉钉 Stream 卡片回调实测通过，失败则钉钉按 proposal §8 降级（仅文本摘要），范围收窄记录在 tasks。
- **降级路径**：未配置 im.json、SDK 初始化失败、卡片发送失败——记日志并回落文本摘要；文本摘要链路（M3）不删。

**数据与并发**

- 行动存储仍为单文件 JSON + 原子写；多人/多渠道同时审批按先到先得，后到方收到「已被处理」回执（对平台重试天然幂等）。
- `data/actions.json`、`im.json`、`notify.json`、推送状态随生产实例单点存在（Mac mini），不随 git 同步——README 双机说明改写：Mac mini = 生产（唯一事实源），MacBook = 纯开发机。

## Testing Decisions

- 好测试只测外部行为：输入（配置/回调载荷/目录内容/HTTP 请求）→ 可观察输出（store 变化/回执/HTTP 响应/卡片数据结构），不测内部调用序列。
- 测试缝（沿 M3 已有缝扩展，新增两条）：
  1. **既有缝复用**：API 端点（注入 dataDir/tmpdir 起 server 测 HTTP 行为）；行动存储纯函数；digest 纯函数。
  2. **新缝 · IM 适配器边界**：卡片数据结构生成与回调处理均为纯函数（fake store / 注入配置）；SDK 真实网络交互只在 M4b/M4c 验收时人工实测（demo 前置门 + 真实周报 e2e）。
  3. **新缝 · 推送触发**：目录扫描纯函数（注入 fixture 目录与上次推送期次）；定时器 wiring 不进单测。
  4. **新缝 · 静态服务**：起 server 后断言 GET / 返回 index.html、未知路径 SPA fallback、/api 路由不受影响。
- 前端：沿组件契约缝（mock fetch）；新增留痕展示的渲染断言。
- 先例：M3 `notify.test.ts`（payload 差异/幂等/失败不抛）、`actions.test.ts`（四态校验/原子写）、`server.test.ts`（注入 tmpdir 起服务）。

## Out of Scope

- IM 内 H5 移动版（B 层，随档 2 公网升级解锁）与免登
- 企业微信、个人微信（公众号/小程序）渠道
- 卡片上输入备注、多审批人（或签/会签）、超时未审提醒
- 原生审批中心（飞书/钉钉审批 API）对接
- 公网部署、域名、HTTPS、API 会话鉴权（档 2 内容；本期维持内网边界）
- 数据存储迁移（SQLite/DuckDB 仍为 M5+ 候选）
- 前端移动端适配（手机连 WiFi 访问 PC 版仅作应急兜底，不做适配）

## Further Notes

- 红队 KA5（卡片信息密度）在 M4b 卡片文案设计时用 M2 真实结论 mock 自验；若「不敢盲批」成立，触发档 2/B 层优先级重议（escalation 而非静默改分期）。
- 卡片消息频控：自建应用单聊推送一般无硬限，M4b 实测确认；有则加发送间隔。
- Mac mini 睡眠期间推送延迟可接受（周审批非实时场景），README 明示，不引入 caffeinate 强制常醒。

## GRILL 决议（留白自答，2026-09-27）

1. **期次推送幂等粒度**：文本摘要 + N 张 high 卡片为一个整体，全部成功才落 `lastPushedPeriod`；任一失败下轮扫描全量重试，重复推送窗口明示接受（沿用 M3 GRILL 决议 4 的单机哲学）。
2. **HTTP PUT 不接受 decidedBy**：无鉴权端点防伪造留痕；decidedBy 只由卡片回调路径写入；PC 渠道 `via='pc'`、decidedBy 留空。
3. **审批落库并发**：单实例进程内，回调与 PUT 的 read→update→write 保持同步无 await 间隙（天然原子）；先到先得，后到方收到「已被处理」回执文案而非报错。
4. **卡片结果态更新失败**：落库是事实源，卡片更新 best-effort（记日志），不回滚审批。
5. **生产运行形态**：后端 tsx 直接跑（不加构建步骤）；launchd LaunchAgent（RunOnLoad + KeepAlive）执行生产脚本（PORT=9642、HOST=0.0.0.0）；plist 模板入 `scripts/`，安装命令进 README。
6. **im.json 细节**：`platforms` 数组飞书/钉钉共存；`approverUserId` 为平台侧用户标识，`approverName` 用于卡片结果态与 decidedBy 展示。
7. **卡片按钮回调载荷**：编码 actionId + decision（accept/reject），适配层完成验签与解包后交纯函数处理。
8. **定时扫描细节**：60 秒间隔；仅比对「目录最新期次 > lastPushedPeriod」才触发构建+推送；扫描只读文件名（轻量），看板访问触发的推送保留为兜底。
9. **用户配合步骤（执行依赖）**：M4b 前需用户在飞书后台创建自建应用并提供 appId/appSecret/approverUserId 并真机配合 demo 实测；M4c 同理钉钉。tasks 中立显式任务项，届时等待用户输入。
10. **前端留痕展示**：行动项状态旁次级文本「审批人 · MM-DD HH:mm」；无 decidedBy 时维持现状；跨周对照区结构不变。
