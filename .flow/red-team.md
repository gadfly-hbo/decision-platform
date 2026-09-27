# Red-Team: M4 移动审批 · 飞书+钉钉卡片直审（内网 Mac mini 单实例）

对 `.flow/proposal.md`（v1.1 定稿）的红队拷问。2026-09-27。

### Top Kill-Assumptions (ranked)

**KA1 · 推送会自动发生（plan 未覆盖的既成缺口，已用代码证实）**
- **Claim:** proposal 沿用 M3 表述「新期次周报计算完成后自动推送」→ 卡片直审的前提是卡片会被推出去。
- **Fails if:** 推送触发仍挂在 `GET /api/dashboard` 上（现状：`server/index.ts:167`，唯一调用点）。Mac mini 单实例 + 决策人在手机上 = 没有人打开看板 → 周报导入后卡片**永远不会发出**，移动审批形同虚设。
- **Evidence to get this week:** 已获取——代码检索确认 `maybePushNewPeriod` 仅由看板请求触发，无定时器/文件监听。
- **Kill criterion:** 不适用（不是风险，是已证实的设计缺口）。M4 必须把推送触发独立化（launchd 定时扫描 `data/raw` 新期次或进程内定时器），否则 M4b 验收「周报导入后 ≤1 分钟收到卡片」不可能通过。
- **Cheapest test:** M4b 验收用例本身就是测试：导入周报后不打开看板，等卡片。

**KA2 · 飞书自建应用 + 长连接卡片回调在内网实测可行（M4b 地基）**
- **Claim:** 免费版企业可建自建应用，Node SDK 长连接可收卡片按钮回调，无需公网。
- **Fails if:** 用户无企业管理后台权限建不了应用；或长连接模式下卡片回调实际要求回调 URL 配置；或卡片更新接口受权限限制。
- **Evidence to get this week:** 飞书后台建免费企业 → 建自建应用 → 官方 Node SDK（`@larksuiteoapi/node-sdk`）跑 demo：发一张带按钮卡片到自己手机，点按钮在本机收到回调，回调里更新卡片。约 30–60 分钟。
- **Kill criterion:** demo 无法在纯内网跑通且无官方替代 → 飞书降级文本摘要，M4 核心价值失效，回到用户重议。
- **Cheapest test:** 上述 demo（M4b 开工前完成，作为前置门）。

**KA3 · Mac mini 能承载常驻服务（运维地基）**
- **Claim:** Mac mini 常驻运行服务即可靠；launchd KeepAlive 解决一切。
- **Fails if:** ① macOS 睡眠时段推送/回调延迟（可接受？审批非实时强需求，可能可接受但要明示）；② 生产实例与开发实例端口冲突（`dev:all` 已占 5180/8642，M4a 若原端口常驻则无法再本地 dev）；③ macOS 自动更新重启；④ 家庭网络出口 IP 变化影响长连接重连（SDK 自动重连，风险低）。
- **Evidence to get this week:** 确认 Mac mini 节能设置（睡眠/唤醒）；决定生产端口策略（生产换端口 or 绑定地址区分）。
- **Kill criterion:** Mac mini 无法保持常开（如公司规定关机）→ 部署档重议（树莓派/云主机档 2）。
- **Cheapest test:** `pmset -g` 看睡眠策略；M4a 验收含「重启后自动恢复」。

**KA4 · 钉钉 Stream 模式支持本方案卡片类型（M4c 前置，已有降级预案）**
- **Claim:** ActionCard 按钮回调可走 Stream（WebSocket），个别卡片场景强制 HTTP 公网。
- **Fails if:** 目标卡片类型的按钮回调实测强制 HTTP 回调 → 钉钉无法纯内网直审。
- **Evidence to get this week:** 钉钉开发者后台建企业内部应用 + Stream Node SDK demo：Stream 收卡片回调。约 30–60 分钟，M4c 开工前做。
- **Kill criterion:** 实测不通 → 钉钉降级文本摘要+回 PC（proposal §8 已预案，M4c 范围收窄，flow 不中止）。
- **Cheapest test:** 上述 demo。

**KA5 · 卡片信息密度足够拍板（产品假设）**
- **Claim:** 无【详情】跳转的卡片（标题+关键数字+归因一句话+按钮）足以让决策人负责任地采纳/驳回。
- **Fails if:** 结论需要看推导链/归因明细才能判断（M2 结论的 summary 不够自解释），决策人对卡片盲批或全部拖回 PC——「30 秒审批」不成立。
- **Evidence to get this week:** 用 M2 真实结论的 title+summary+top 归因行 mock 卡片文案，决策人自问「敢不敢直接点采纳」。
- **Kill criterion:** 真实数据下高优结论 mock 卡片被判「不敢盲批」→ 卡片带结论 summary 全文 + 归因 top 3 行仍不够 → B 层优先级提前（档 2 或局域网 H5 兜底提前），分期重议。
- **Cheapest test:** 文案 mock（PRD 阶段顺手做，进卡片文案设计）。

### What's Well-Reasoned

- **复用现有四态行动 API 而非新建审批系统**——数据模型、幂等语义、原子写都已就绪，M4 本质是触达层工程，范围克制。
- **先地基后集成的分期**（M4a→M4b→M4c）依赖链正确；顺带解决 M3 已知限制（双机 actions.json 分裂）。
- **平台收窄有事实依据**（回调通道能力已核实），企微/个人微信排除理由充分，不是拍脑袋。
- **B 层随档 1 推迟的连带约束被明示**而非隐藏；钉钉降级路径预先写进方案。
- 默认假设（首发飞书、单人拍板先到先得）与现有产品形态一致，留了 ASSESS 推翻口。

### What I Couldn't Assess

- 审批人到底是谁（用户本人 or 他人）、几人——影响 decidedBy 语义与卡片推送目标配置（单聊 userid 需要通讯录权限）。
- 用户是否具备飞书/钉钉企业管理权限（KA2/KA4 的前置）——未确认。
- 卡片消息在两家平台的频控/审核限制（自建应用单聊推送一般无硬限，未实测）。
- M3 上线仅 1 天，PC 端行动标记率与推送响应尚无数据——移动审批的需求强度最终由真实使用说话（M2 红队 KA1 的延续观察项）。

## Verdict: GO

无 kill criterion 已命中。KA1 是已证实的设计缺口但可在 M4 范围内修复（PRD 必须显式立「推送触发独立化」切片，且 M4b 验收以「不打开看板也能收到卡片」为准）；KA2 是 M4b 开工前置门；KA4 是 M4c 开工前置门（自带降级）；KA3 在 M4a 验收覆盖。
