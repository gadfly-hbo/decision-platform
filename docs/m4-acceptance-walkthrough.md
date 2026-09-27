# M4 验收走查 · 移动审批（飞书卡片直审，内网单实例）

2026-09-27，配合 `.flow/`（proposal/PRD/tasks）与 README「M4 功能」。全部为**真机实测**记录，非模拟。

## 1. 前置门 demo（红队 KA2，切片 5）

`npx tsx scripts/feishu-demo.ts`（内网 Mac mini，无任何公网入站）：

- ① 长连接建立：飞书 `@larksuiteoapi/node-sdk@1.74.0` LarkChannel 出站 WSS 握手成功；
- ② 手机号 → open_id 自动解析（`contact.user.batchGetId`）并回写 `data/im.json`；
- ③ 交互卡片送达审批人单聊，真机点击【采纳】→ 本机收到 `cardAction` 回调（operator openId + `{actionId, decision}`）→ `updateCard` 成功，卡片变为「已采纳 · 黄博」。

结论：**KA2 不成立**，内网零公网假设成立。

## 2. 全链路 e2e（切片 6，`scripts/e2e-feishu.ts`）

隔离数据（tmp 目录 + 样本期次 2026-10-03，生产 `data/` 不受影响），服务起来后**不打开看板**：

- ① 启动后 2 秒首扫：文本周摘要 + 2 张高优结论卡片（样本数据含 2 条 high 结论）自动送达手机；
- ② 两张卡先后点击【采纳】：14:48:07 / 14:48:09 两次回调均落库，留痕 `decidedBy=黄博 / decidedVia=card / decidedAt`，`period=2026-10-03`；
- ③ `/api/dashboard` 同步可查：行动 `a-divergence-1`（结论 c-divergence/high）状态 accepted。

第一跑因未预先通知用户点卡，240 秒窗口空等（推送链路已验证、回调未点）——**协调失败，非代码缺陷**；重跑通过。

## 3. 真机暴露的问题与处置

| 观察 | 定性 | 处置 |
|---|---|---|
| 第一跑遗留的陈旧卡片，服务退出后点击提示「目标回调服务目前未在线」 | 已知限制：停机窗口点击丢失 | launchd 常驻 + KeepAlive 基本消除；README 已知限制记录 |
| 旧期次卡片在服务在线时点击会被当有效审批落库（用户真机触发） | **真缺口**：proposal §8 要求期次校验，实现遗漏 | 已修（TDD）：卡片按钮 value 携带 period，回调与目录最新期次比对，落后→回执「已过期」不落库；新增 3 组测试（过期/防重/非法载荷） |
| 卡片信息密度（KA5：无【详情】跳转敢不敢拍板） | 用户判定「敢」 | 维持现文案结构；档 2/B 层不提前 |

## 4. 范围决策记录

- **钉钉暂缓**（2026-09-27 用户决策）：前置门 demo 与 Stream 适配器不做；im.json 的 dingtalk schema、IM 平台无关纯函数层已预留，列 M5+ 候选。红队 KA4 随之挂起。

## 5. 单测覆盖（缝见 `.flow/state.json` context.seams）

API 端点（静态服务/SPA fallback/路径穿越/PUT 防伪留痕）、行动存储纯函数（留痕/回滚清空/兼容）、推送触发（目录扫描/幂等/调度器 stop）、IM 纯函数（配置校验/卡片模型/回调 含期次与防重）、飞书桥接（channelFactory 注入：发文本+卡片、回调落库、过期回执）。全套 `npm run verify`（tsc + vitest + vite build）。
