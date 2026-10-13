# REVIEW 报告：decision-platform M5（报告驱动行动闭环看板）— 第 1 轮

评审者：独立 explore 子代理（全新上下文，2026-10-13）。基点 0e8690d，baseline_dirty=[]。

## verify 证据核对

评审者重跑 `npm run verify`：exit 0，14 文件/139 测试全绿，vite build ✓，与记录证据一致，无伪造。HEAD 与 review_base 相符。

## verdict: FAIL（3 项 blocking；无架构性问题，修复后可直接 PASS）

### Blocking

- **B1** G3「force 重抽保护已决项」零测试覆盖且测试标题虚报已覆盖（`server/reports.test.ts:133` 未构造 adopted/dismissed/带任务项；`deleteStaleSuggested` 无直接调用测试）。实现 SQL 本身正确。复检：构造三类受保护项 + 一条 suggested，断言前三者存活、后者删除重建。
- **B2** 切片 1 验收点「输入裁剪」（REPORT_CLIP_CHARS=16_000）与「备用链切换」（fallbacks）无任何测试。复检：>16k 报告断言 prompt 截断；主 transport 抛 ProviderFailure 后落到 fallback 并成功。
- **B3** `DELETE /api/actions/:id` 未实现，但 PRD API 清单与 UI 契约 §2.3 均声明其存在（契约明确「不设 UI 按钮」仅指界面）。复检：补路由（含 404）或出勘误，二选一落档。

### Non-blocking（记录不行动）

1. dismissed→adopted 改判被实现禁止，契约 §2.3/§4.1 写「可改判」——需钉死单向性或放开（裁定：保持禁止，契约勘误）。
2. API 层已 dismissed 项可经重复驳回+不同理由覆盖看板渠道理由（board.ts:156-171），与契约 §2.13「理由只读」精神相悖（裁定：并入本轮修复，改 400）。
3. 后端不可达时前端回退演示态（G7 气味，有 chip 标注、有测试钉死；接受现状）。
4. extracting 状态进程崩溃后无恢复路径（自动漏斗只处理 pending/failed，S1b 无操作钮）（裁定：并入本轮修复，scanReports 复位 extracting→failed）。
5. 报告空态/过滤空态边界：聚焦 0 行动项报告显示过滤空态；全部 pending/failed 时主区空列表（后续打磨）。
6. S1 元信息行尾「人工 {n}」不在契约钉死文案内（勘误入术语表）。
7. PRD API 文字偏差：health 未带模型链（放 dashboard.modelChain）；POST /api/actions 忽略 sourceKind 参数（PRD 勘误）。
8. slug 冲突静默吞报告（`a b.md` 与 `a-b.md` 同 slug，第二份不可达无提示）（后续加固）。
9. 多报告一轮推送重复同一份全局摘要文本（轻微）。
10. App.test 2 处 act() 警告（RunDrawer 异步更新，不影响断言）。

### 已核对无问题的关键面

proposal/PRD 主干（输入物=报告、闭环四段、G10/G11/G12、飞书幂等/留痕/高优过滤）；pi-agent-runtime 0.4.1 vendored 接入与 SDK types 逐项吻合；密钥只进 env、审计仅安全元数据；SQL 全参数化；路径穿越防线；UI 契约逐字文案抽检全过；三枚新增 token 数值一致；echarts/旧管线零残留；TS strict/零 any/测试走公共缝/README 相符。

## 结论

修复 B1-B3（+裁定并入的 N2/N4）后可直接复验。

---

# REVIEW 第 2 轮（2026-10-13，全新评审者）

verify 重跑两次 exit 0（14 文件/144 测试/build ✓），证据属实。

## verdict: PASS

- 上一轮 5 项修复全部真实落地；经 /tmp 副本变异验证确认测试非恒真（破坏实现→目标测试精确变红，恢复→28/28 回归绿）。
- 修复轮新问题排查：DELETE 三层级联正确；scanReports 复位有 inFlight 守卫不误伤进行中抽取；N2 与卡片渠道交互安全（卡片重复点击在 im.ts 前置短路）。
- 抽查面全过：G12 注入测试、飞书幂等、SDK 用法、UI 契约逐字文案 8 处、SQL 参数化/路径穿越/密钥安全。
- 范围外猎错：未发现。

## Non-blocking（新记录，留档）

1. inFlight 防误伤路径无直接测试（实现正确）。
2. inFlight 为模块级 Set，跨 pipeline 实例共享——生产单 pipeline 无影响。
3. PATCH /api/actions/:id/tasks 非契约路径落入 404，无害。

---

# M6 REVIEW（2026-10-13，全新评审者）

verdict: PASS（无 blocking）。四点用户决策逐条落实（清空重建/无 JuanerAI 占位/飞书全局+【项目名】+projectId:slug 幂等/硬删弹窗逐字）；G1'-G7' 抽检过；UI 契约 v5 逐字与禁用词全过；SQL 参数化/级联/竞态收敛核过；测试有效性抽查非恒真。verify 重跑一致（15 文件/157）。

Non-blocking 7 项：#1 同名 force 判定过窄（controller 裁定升格正确性修复）；#2 extracting 复位惰性化（同上）；#3 空测试；#4 陈旧标题；#5 slug 双份实现；#6 isDemo 残留字段；#7 上传无总量上限（0.0.0.0 部署后续加帽）。未验证项：真实模型冒烟未重跑（只读约束；首启清空旧库为既定行为需提示用户）。

## 修复轮（review_cycles=1）：#1 force 无条件化（同名任何状态一律 force，v1/v2/v3 序列测试钉死）；#2 extracting 自愈挂 board 加载路径（scanReports 内复位+inFlight 守卫）；#3 空测试补真（假通道+0 行动项不推）；#4 标题修正。157→159 全绿。
