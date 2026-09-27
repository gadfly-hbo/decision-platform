# 任务拆解 · M4 移动审批：飞书+钉钉卡片直审（内网单实例）

> 来源：`.flow/prd.md`（含 GRILL 决议 1-10）；gated 拆解自批准（2026-09-27）。无 issue tracker，落盘 `.flow/tasks.md`。

- [x] 1. M4a-地基：静态文件服务 + 生产端口/环境变量 + launchd 模板 + README 部署节
- [x] 2. M4a-留痕：ActionRecord decidedBy/decidedAt/decidedVia + 回滚清空 + PUT via=pc + 前端标注
- [x] 3. M4a-推送触发独立化：60s 定时扫描纯函数 + wiring（KA1 修复）
- [x] 4. IM 适配核心（平台无关）：im.json 配置 + 卡片数据结构纯函数 + 回调处理纯函数 + 文本降级
- [x] 5. 飞书前置门（用户配合）：创建自建应用 + 内网 demo 实测发卡/收回调/更新卡（红队 KA2）——2026-09-27 三步实测通过，open_id 已解析回写
- [x] 6. M4b-飞书卡片直审：SDK 长连接接入 + 定时扫描推送 high 卡片 + 回调落库 + 卡片结果态 + e2e——2026-09-27 真机 e2e 通过（自动推卡→手机采纳→留痕→看板同步）；补期次校验（旧期次卡片回执「已过期」不落库，proposal §8）；「服务停机窗口点击=未在线提示」为已知限制（launchd 常驻缓解），README 记录见任务 8
- [x] 7. M4c-钉钉：**暂缓（2026-09-27 用户决策）**——适配器与前置门 demo 不做，im.json 的 dingtalk schema 与 IM 纯函数层已预留，移入 M5+ 候选；KA5 用户判定「敢」（卡片密度达标，档 2/B 层维持推迟）
- [x] 8. 收尾：README 双机/安全/部署/M4 功能说明改写 + 全链路 e2e 走查（docs/m4-acceptance-walkthrough.md，sample 期次代真实周报，下期真实导入时回归）+ 演示数据回归（152/152）

---

## 1. M4a-地基：静态文件服务 + 生产运行形态

### What to build

后端同端口服务前端构建产物：`dist/` 存在时 `GET /` 返回 index.html、未知非 API 路径 SPA fallback、`/api` 路由优先且行为不变；`dist/` 不存在时行为完全不变（本地开发照旧）。环境变量 `PORT`/`HOST` 生效（生产 9642 / 0.0.0.0，开发默认 8642 / 127.0.0.1 不变）。提供生产启动脚本（build + tsx 起 server）、launchd LaunchAgent plist 模板（RunOnLoad + KeepAlive）与安装命令，README 新增「内网单实例部署」节（端口、局域网访问地址、睡眠设置建议、安全边界改写：仅可信局域网、禁止端口映射公网）。

### Acceptance criteria

- [ ] 注入 tmpdir 起 server：`dist` 存在时 `GET /` 返回 200 HTML、`GET /some/route` SPA fallback、`/api/health` 等路由不受影响
- [ ] `dist` 不存在时所有既有路由行为与现状一致（无静态逻辑干扰）
- [ ] `PORT`/`HOST` 环境变量在启动入口生效
- [ ] plist 模板 + 生产脚本可执行；README 部署节含安装与睡眠建议
- [ ] `npm run verify` 全绿

### Blocked by

None - can start immediately

## 2. M4a-留痕：审批人字段贯穿存储/API/前端

### What to build

行动记录新增可选字段 `decidedBy`/`decidedAt`/`decidedVia`（card|pc）：状态机更新时按渠道写入（卡片回调路径传审批人名；HTTP PUT 固定 `via='pc'`、忽略请求体中任何 decided* 字段防伪造，GRILL 决议 2）；状态回滚到 pending 时三者清空；历史记录无此字段时向后兼容。PC 看板行动项在状态旁展示「审批人 · MM-DD HH:mm」次级文本（无 decidedBy 时维持现状），跨周对照区结构不变。

### Acceptance criteria

- [ ] 纯函数：带 decided* 的 patch 更新、回滚 pending 清空、旧记录兼容、非法 via 拒绝
- [ ] HTTP PUT：请求体含 decidedBy/decidedVia 时被忽略不落库
- [ ] 前端渲染契约：有留痕展示「审批人 · 时间」，无留痕不渲染该文本
- [ ] 既有 119+ 测试不回归；`npm run verify` 全绿

### Blocked by

None - can start immediately

## 3. M4a-推送触发独立化（红队 KA1）

### What to build

推送不再依赖有人打开看板：服务进程内 60 秒定时扫描周报目录（纯函数：目录 → 最新期次；仅文件名比对，轻量），发现「最新期次 > lastPushedPeriod」时执行构建+幂等推送（GRILL 决议 1：文本+卡片整体成功才落状态，失败下轮全量重试）；看板访问触发的推送保留为兜底。定时器为薄 wiring，不进单测；真实触发路径 e2e 手测（导入周报后不打开看板，等推送）。

### Acceptance criteria

- [ ] 纯函数：fixture 目录多期 CSV → 正确最新期次；空目录/无有效文件 → null 不触发
- [ ] 纯函数：期次比较与幂等门语义（≤ lastPushedPeriod 跳过）
- [ ] server 启动即挂扫描定时器、关闭时不泄漏（server.close 后 timer 清理）
- [ ] `npm run verify` 全绿

### Blocked by

None - can start immediately

## 4. IM 适配核心（平台无关纯函数层）

### What to build

`data/im.json` 读取校验（platforms 数组：platform/appId/appSecret/approverUserId/approverName，损坏按未配置处理，沿 notify.json 惯例）。卡片数据结构生成纯函数：Conclusion → 卡片模型（严重度+标题、关键数字、summary 全文、归因 top 3 渠道行、按钮 accept/reject 编码 actionId，KA5 文案结构）。回调处理纯函数：回调载荷（actionId+decision+操作者）+ 当前 store → 新 store（复用行动状态机+留痕，先到先得）+ 回执文案（成功结果态/已被处理提示/非法载荷拒绝）。平台差异只体现在适配器层，本切片零网络依赖。

### Acceptance criteria

- [ ] im.json 读取：合法/缺失/损坏/字段非法四态
- [ ] 卡片模型：真实 M2 结论 fixture → 含全部文案要素与按钮编码；归因不足 3 行时取实际行数
- [ ] 回调处理：accept/reject 落库+留痕、重复回调返回已被处理回执且 store 不变、非法 actionId/decision 拒绝
- [ ] `npm run verify` 全绿

### Blocked by

2（留痕字段与状态机语义）

## 5. 飞书前置门（用户配合，红队 KA2）

### What to build

用户在飞书开放平台创建免费企业 + 企业自建应用（机器人能力、卡片交互、消息权限、长连接事件订阅），把 appId/appSecret/审批人 userId 填入 `data/im.json`。随后内网 demo 实测：官方 Node SDK 长连接向审批人手机发一张带按钮卡片 → 点按钮本机收到回调 → 回调内更新卡片为结果态。**本任务是用户配合步骤：flow 将等待用户提供凭证与真机测试结果，实测不通则按红队 KA2 kill criterion 升级重议。**

### Acceptance criteria

- [ ] `data/im.json` 存在合法飞书配置（不入库）
- [ ] demo 三步实测通过：发卡 / 收按钮回调 / 更新卡片（纯内网，无公网入站）

### Blocked by

None - can start immediately（与 1-4 并行）

## 6. M4b-飞书卡片直审

### What to build

飞书适配器接入（官方 Node SDK 长连接）：定时扫描（切片 3）发现新期次时——high 结论逐条发交互卡片给审批人单聊（卡片模型来自切片 4，飞书 schema 翻译）+ 其余结论文本摘要（沿 M3 digest，经应用消息或群机器人降级）；卡片按钮回调经验签解包交切片 4 纯函数落库，随后更新卡片为结果态（失败 best-effort 记日志，GRILL 决议 4）；SDK 初始化失败/发送失败回落文本摘要并记日志。e2e：真实周报导入 → 不打开看板 → 手机收卡 → 采纳 → 卡片变结果态 → PC 看板同步。

### Acceptance criteria

- [ ] 适配器接口（发卡/收回调/更新卡）实现且平台细节被隔离在适配层内
- [ ] 端到端手测全链路通过并记录走查（docs/）
- [ ] 卡片文案用 M2 真实结论自验 KA5（「敢拍板」）；不成立则升级而非静默改分期
- [ ] 未配置/失败降级路径可用；`npm run verify` 全绿

### Blocked by

3（触发）、4（卡片/回调纯函数）、5（前置门通过）

## 7. M4c-钉钉卡片直审（含前置门，红队 KA4）

### What to build

先用用户创建的钉钉企业内部应用实测 Stream 模式卡片按钮回调（demo 同切片 5 三步）；通过 → 按切片 6 同样接口实现钉钉 Stream 适配器（复用切片 4 纯函数与推送策略，双平台共存按配置分别推送）；实测失败 → 钉钉按 proposal §8 降级为文本摘要，在 tasks 记录范围收窄，flow 不中止。

### Acceptance criteria

- [ ] 前置门实测结论显式记录（通过/降级）
- [ ] 通过：双平台共存 e2e（同一期次按配置各自推送、回调各自落库同一事实源）
- [ ] 降级：钉钉仅文本摘要且配置校验明确提示能力边界
- [ ] `npm run verify` 全绿

### Blocked by

6（适配层接口稳定）

## 8. 收尾：文档与全链路 e2e

### What to build

README 全面改写：内网单实例部署节（切片 1 已建）补充双机说明改写（Mac mini=生产唯一事实源、MacBook=纯开发机、data/*.json 不随 git）、推送与审批链路说明、mac mini 睡眠取舍明示。真实周报全链路 e2e 走查记录入 docs/（导入→自动推送→卡片审批→PC 同步→跨周对照含留痕）。演示数据回归确认（M1 数字自洽契约不受影响）。

### Acceptance criteria

- [ ] README 双机/安全/部署说明与实际行为一致
- [ ] e2e 走查文档落 docs/，覆盖全链路含异常路径（重复点击、未配置降级）
- [ ] 演示数据回归通过；`npm run verify` 全绿

### Blocked by

6、7（主链路完成）
