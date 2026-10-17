# 给 JuanerAI 工程师 Agent：启动 decision-platform（决策看板）固定模块接入

> 本文为转交 JuanerAI 宿主侧（Mac mini 工程师 Agent）的接入启动 Prompt，随本仓 `docs/` 发布；配套基线记录见同目录 `juanerai-integration-baseline.md`。本文身份随所在提交固定，转交时可直接引用提交 SHA。

日期：2026-10-17。任务：按本仓已发布的插件接入标准，将 decision-platform 作为固定随包模块接入 JuanerAI。插件侧只读评估（v0.4，规范包 `6756546a` 已核验）已完成且结论为「插件侧必须项为零」；本任务是你侧（宿主侧）的对齐→接线→验证→固定交付。按本仓工程执行政策与既有 OpenSpec 流程推进，不因本 Prompt 增加新审批 Gate。

## 1. 插件定位（本任务的产品语境）

**decision-platform 在 JuanerAI 价值链的位置：分析产出之后。**

- **职责**：分析报告输出后，与业务沟通分析结论 → 确定执行动作 → 结果反馈闭环。具体形态：上传分析报告（md/txt/csv/pdf/docx/doc/pptx/xlsx/图片）→ agent 抽取决策建议行动项（报告原文逐字引用、四级证据等级、由证据派生的置信度）→ 看板/飞书卡片拍板（采纳；驳回必填理由）→ 采纳项拆任务（负责人/截止日/状态）→ 执行后回录反馈（结果/指标变化/复盘/评分）→ 驳回理由与人工补充作为 teach 信号校准本项目后续抽取（项目级隔离）。
- **与 Report Studio（reports-factory）的分工——互补不重叠**：Report Studio 是**报告呈现层**（用 PPT 等报告格式制作与交付分析报告）；decision-platform 是**决策执行层**（分析结论 → 执行动作 → 结果反馈闭环）。链路上前者的产出（分析报告文件）正是后者的输入（上传即触发抽取）。两者随包并存，各自独立进程/数据/版本，不合并 UI、数据库或 SDK 账本。
- **代表集成用户故事（建议首次接线的闭环）**：JuanerAI/Report Studio 完成一项分析 → 报告文件投入决策看板某项目 → 业务在看板（或宿主入口）拍板采纳/驳回 → 采纳项拆任务 → 回录一条反馈。

## 2. 必读材料（按序，固定身份）

1. 本仓 `docs/engineering/plugin-integration/README.md`（PR #93，提交 `6756546a1423162b16a552b24b83bdaa1e834e50`）及 `standard.md`；按需 `acceptance-checklist.md` 与 `report-studio-reference-adapter.md`（后者是 Report Studio 专属实现导览，按其「复用粒度」表只取模式，不照搬文件）。
2. **插件集成基线记录**：decision-platform 仓 `docs/juanerai-integration-baseline.md`（提交 `8ae652ce53fc27d3be92098517643a419f9b73eb`，M10）——含物料指纹、接入面摘要、升级保护约定。这是插件侧交接的权威文件（与本文同仓同目录）。
3. 插件仓：`github.com:gadfly-hbo/decision-platform`（Mac mini 若无 checkout 则克隆；**采用时固定精确提交**，当前候选 `8ae652ce…`，不追随 main。本文与基线文档均在该仓 `docs/` 下，拉取即得）。

## 3. 插件接入面速览（已经插件侧评估核实，免重复盘点）

- **入口三形态**：HTTP API（17 路由）；库入口 `startServer(port, host, ServerOptions)`（全量依赖注入）；就绪探针 `GET /api/health`。
- **最小任务闭环 API**：`POST /api/projects {title,purpose?}` → `POST /api/projects/:id/reports {files:[{filename,contentBase64}]}`（≤20MB/文件；上传即异步触发抽取；同名覆盖=重抽且保护已决项）→ 轮询 `GET /api/projects/:id/board`（reports[].status: pending|extracting|done|failed）→ `PATCH /api/actions/:id {status:'adopted'}` / `{status:'dismissed', dismissedReason}` → `POST /api/actions/:id/tasks`、`POST /api/tasks/:id/feedback`；失败重试 `POST /api/projects/:id/reports/extract {slug,force}`。
- **数据根**：直接执行入口支持 `DATA_ROOT` env（M10 新增，覆盖 board.db/projects/im.json/notify*/agent-* 全部运行数据；缺省 `<cwd>/data`）。库形态走 options 显式注入。
- **前端**：纯相对 `/api` fetch、零基址硬编码——反代同源即可整屏复用；也可首期仅 API 无 UI。
- **密钥**：`MINIMAX_CN_API_KEY`（主 MiniMax-M3 多模态）/ `XIAOMI_TOKEN_PLAN_CN_API_KEY`（备 mimo）env 注入优先；缺密钥不阻塞启动，抽取落 failed「模型不可用」。凭据不进配置/日志/审计。
- **LLM 链**：插件自带 vendored `pi-agent-runtime-0.4.1.tgz`（SHA256 `1ddace3a…`，见基线文档），单次保护 + 权威账本 + 安全审计齐备——**不与宿主 SDK 统一版本/Session/账本**（标准 §4 允许）。
- **幂等/生命周期**：抽取同进程单飞；重启遗留 extracting 自愈复位 failed 可重试；推送幂等键 `projectId:slug`（未配 IM 时推送自动跳过）。
- **运行依赖**：Node ≥ 24.21.0；npm 依赖含原生/重型包（pdfjs-dist、@napi-rs/canvas、word-extractor、jszip、lark SDK），随包物料需按标准 §1 携带依赖与通知。

## 4. 待你正式确认的三项合同决策（插件侧已给推荐默认）

| 决策 | 推荐默认（依据） | 需你确认的内容 |
|---|---|---|
| 承载形态 | **子进程 + HTTP**（e2e 已验证该模式；`PORT/HOST/DATA_ROOT` 使装配不依赖 cwd） | 进程归属/启停/就绪超时/端口分配 |
| UI 呈现 | **反代同源整屏**（前端零硬编码） | 或 iframe / 首期仅 API |
| 密钥提供 | **宿主 env 注入**（插件 env 优先且不被磁盘回落覆盖） | 与宿主密钥保管策略对齐 |

另有一项产品决策：插件自带飞书卡片直审（`data/im.json`）是否启用——建议首期**不配置**（推送面由宿主统一），插件侧行为自动降级为无推送。

## 5. 工作要求

- 按标准 §5 五步推进；「盘点」插件侧已完成（见基线文档），你的盘点对象是**宿主侧**（装配点、任务/成果映射、访问边界、打包工具链）。
- **接线产物是薄 Adapter/Profile**：进程管理 + 就绪探针 + owner token/回环/origin 守卫（参考 Report Studio `local-access` 模式；插件 API 无鉴权是内网单用户假设，宿主暴露面必须自建）+ 任务↔项目/报告映射 + 成果读回。**不重写插件业务、不复制两份业务逻辑**。
- 数据隔离：宿主实例使用自己的 `DATA_ROOT`（宿主用户空间）；插件 SQLite 独立，不并宿主库。
- 验证：从 `acceptance-checklist.md` 选适用项（建议 C01 固定身份、C02 双交付、C03 生命周期、C04 坏输入、C05 合成凭据/路径、C08/C09 回链与持久、C10 SDK 合成 codec）；先确定性合成接缝，真实 Provider/真实报告按授权执行。M5 旧库自动删文件重建为破坏性迁移——宿主新数据根首启需验证一次。
- 固定交付与记录：首次采用即建立 source-identity（精确提交 + vendor tgz SHA + lockfile SHA——**lockfile 采用时重算**，基线文档值仅为落档时点）；采用、安装/运行、发布、接受分别记录，不互相代替。

## 6. 边界与红线

- 业务实现与中立修复在插件原仓维护；宿主侧如需插件改动，走原仓任务，不在宿主副本改业务（当前宿主副本修改与回流状态：**尚未发生**）。
- 不能证明新物料保留已验业务修复或数据兼容时，**阻止该次新升级、保留旧验收包**；活动/UNKNOWN 任务不热换；程序回滚不等于数据可逆。
- 不统一插件间 SDK 版本、Session、存储或物理账本；不为假想需求给插件加 Agent/UI/鉴权 hook（插件侧评估已裁定可后置）。

## 7. 交回

按标准 §5/§6 记入既有 OpenSpec/验证章节：已读取材料与身份、三项决策的确认结果、Adapter 接点清单、验证证据（区分「已有记录证明」与「本轮执行」）、source-identity 与升级基线差异表、未执行/UNKNOWN 清单。区分「已读取/已采用/经证据验证符合」，不以静态对照宣称运行验证通过。
