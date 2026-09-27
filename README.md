# decision-platform · 决策看板

从数据分析到决策看板：打开就知道**今天/本周要拍板什么**——结论先行、证据可展开核查（推导链路 + 归因贡献）、行动可直接采纳。验收标准：打开看板 30 秒内能说出要拍板的一件事。

## 一键启动

- **Mac mini（本仓库日常开发机）**：终端 `npm run dev:all`，或 Finder 双击 `启动决策看板.command`。
- **MacBook**：`git pull` 后同样双击 `启动决策看板.command`（首次自动 npm install）。
- 端口：前端 **5180**、后端 **8642**（已避开兄弟项目 5173/4173/8787 等）；Ctrl+C 双端同停。
- 安全边界：开发模式后端仅监听 **127.0.0.1** 且写端点无鉴权。生产模式（见下节）会绑定局域网地址——**仅限可信内网使用，禁止把端口映射/暴露到公网**（上公网前必须先加鉴权与 HTTPS）。

## 内网单实例部署（M4 起，生产形态）

Mac mini 常驻单实例 = 唯一事实源（数据 `data/*.json` 与推送状态都在这台机器）；MacBook 定位纯开发机。

```bash
# 一次性安装（开机自启 + 崩溃自动拉起）
cp scripts/com.decision-platform.prod.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.decision-platform.prod.plist
```

- 生产端口 **9642**（`HOST=0.0.0.0`，局域网可访问），与开发端口 8642 并存互不干扰；`npm run prod` = 前端构建 + 后端服务静态产物（局域网设备直接开 `http://<mac-mini>:9642/`，无需 vite）。
- 日志：`data/prod.log`（launchd 追加写）。重启 Mac 后服务自动恢复（RunAtLoad + KeepAlive）。
- 节能建议：系统设置 → 节能 → 关闭「自动睡眠」（或显示器睡眠即可、电脑不睡）；睡眠期间推送/审批会延迟到唤醒，周审批场景可接受。
- 换机器部署：改 plist 内工作目录路径后重新 load。

## 每周数据更新（M2 起）

把最新一期会员周报 CSV 放进 `data/raw/` 即可（文件名含日期，如 `会员周报4213-2026-09-26….csv` 或 `20260926` 均可识别，取日期最新的一份）。刷新看板后：

- 后端解析 CSV → **同比一律由本期/同期重算**（源表声明列不读，实测有错）→ 规则引擎检测异动（带规模门槛，过滤小基数噪声）→ 归因到「运营模式·二级渠道」→ 生成结论。
- 后端不可用或目录无 CSV 时，看板回退演示数据并标注「演示数据」。
- 解析失败会在后端日志显式告警（接入即校验，不静默）。

## 开发

```bash
npm run verify   # tsc + vitest + build 三重门
npm run test     # 仅测试
npm run dev      # 仅前端（5180，/api 代理到 8642）
npm run server   # 仅后端（8642）
npm run preview  # 构建产物预览（4180，无 /api 代理——会回退演示数据；看真实数据请用 dev:all）
```

## 结构

- `src/` 看板前端（React+Vite+TS+ECharts；结论→证据→行动三区，Xanthil 视觉基线）
- `server/` 后端（node:http + tsx）：`report/` 周报解析、`rules/` 异动检测规则引擎与指标口径、`dashboard.ts` 数据装配
- `data/raw/` 周报 CSV（导入目录）
- `docs/` 走查与验收记录；`.flow/` dev-flow 流程档案（proposal/PRD/审查记录）

## 路线

- **M1（已交付）**：看板形态 + 演示数据。
- **M2（已交付）**：会员周报真实数据 → 异动检测 + 归因，一键启动。
- **M3（已交付）**：告警推送（webhook 幂等）、行动闭环（持久化+跨周对照）、多周趋势（整体指标周序列）。
- **M4（已交付）**：移动审批·飞书卡片直审 + 内网单实例常驻（launchd/静态服务/定时扫描推送）+ 审批留痕。钉钉暂缓（schema 已预留）。
- **后续候选**：钉钉卡片适配（Stream 模式，前置门实测）、桥接失败自动重试建桥（当前降级为文本摘要并记日志，需手动 `POST /api/notify/push` 补推卡片）、非审批人误点改为提示消息不替换原卡、档 2 公网升级 + IM 内 H5 移动版、卡片备注输入、多审批人（或签/会签）、渠道级趋势折线、DuckDB。

## M3 功能

- **行动闭环**：行动状态（待定/采纳/驳回/已执行+备注）持久化在后端 `data/actions.json`，刷新/重启不丢；新周报导入后「行动汇总」区顶部显示**上周行动对照**（上周动作 → 本周该渠道表现）。
- **告警推送**：`data/notify.json` 配置 webhook（`{"platform": "feishu"|"dingtalk"|"wecom"|"generic", "url": "..."}`，文件不入库）；**新期次周报首次计算后自动推送一次**（幂等），也可 `POST /api/notify/push` 手动重推、`POST /api/notify/test` 测试。概览头显示推送状态（未配置/最近推送期次）。
- **多周趋势**：`data/raw/` 累积 ≥2 期周报后，结论展开区自动出现该指标的周度趋势折线；单期时显示累积提示。

## M4 功能 · 移动审批（飞书卡片直审）

- **审批卡片**：`data/im.json` 配置飞书自建应用（`platforms: [{platform:"feishu", appId, appSecret, approverUserId, approverName}]`，手机号可自动解析 open_id 回写，文件不入库）。新期次周报导入后 **约 1 分钟内自动**向审批人单聊推送：文本周摘要 + 每条**高优结论一张交互卡片**（结论全文 + 归因 top 渠道 + 【采纳】【驳回】）——不需要任何人先打开看板。
- **手机直审**：点卡片按钮即完成审批，卡片即时变为结果态（审批人+时间）；留痕（decidedBy/decidedAt/decidedVia=card）写入 `data/actions.json`，PC 看板行动区同步显示「审批人 · 时间」。重复点击/平台重试幂等（「已处理」提示）；**旧期次卡片**回执「已过期」不落库；先到先得（PC 与卡片并发时）。
- **零公网部署**：飞书走**长连接**（服务主动外连，无入站端口），配合上面的内网单实例部署即可用。降级链路：未配置 im.json / 桥接启动失败 → 推送回落 M3 群机器人文本摘要。
- **已知限制**：服务停机窗口内点卡片，飞书会提示「目标回调服务目前未在线」（该次点击丢失）——launchd 常驻基本消除此场景；Mac mini 睡眠期间推送延迟到唤醒；钉钉适配暂缓（配置 schema 已预留）。

### 双机说明（M4 起：Mac mini 生产 / MacBook 开发）

- **Mac mini = 生产单实例（唯一事实源）**：看板、行动记录、审批留痕、推送状态、IM 凭证都在这台机器的 `data/` 下，随 launchd 常驻（见上节）。MacBook/手机在局域网直接开 `http://<mac-mini>:9642/`。
- **MacBook = 纯开发机**：`npm run dev:all` 照常（本地数据/fixtures，不碰生产数据）；要看真实数据就访问 Mac mini 实例，不要在 MacBook 上另起生产实例（会分裂行动记录）。
- `data/*.json`（notify/im/actions/notify-state）与 `data/prod.log` 均不入库；一端开发提交、另一端 `git pull`（拉取前先停本地服务）。
- 可选自动化（不内建）：launchd/cron 每周一提醒导出周报 CSV 放进 Mac mini 的 `data/raw/` 即可，约 1 分钟内自动推送审批卡片。
