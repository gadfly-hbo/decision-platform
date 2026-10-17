# JuanerAI 接入基线记录（插件侧）

日期：2026-10-17（M10 落档）。性质：**静态记录，不是已采用的证明**——截至落档时点，JuanerAI 侧的 Adapter、装配、固定物料与验收**均未发生**。本文供未来宿主采用时按插件接入规范 §6「首次建立升级基线」直接取用；措辞与身份口径遵循只读评估 v0.4（散件规范包已核验）。

## 1. 规范身份（已读取核验）

| 项 | 值 |
|---|---|
| 规范入口 | JuanerAI `docs/engineering/plugin-integration/README.md`（PR #93） |
| 固定提交 | `6756546a1423162b16a552b24b83bdaa1e834e50`（`docs(plugins): publish integration standard and Report Studio reference (#93)`，2026-10-17） |
| 散件规范包 | `juanerai-plugin-standard-6756546a.tar.gz`，19,778 bytes，SHA256 `7407719118b481f5786a6bd2dfda2611c67625cbdda9da414d2563c7ceaba50a`；包内 7 文件与 `SHA256SUMS` 一致，四份正式文件与该提交逐字节一致（git blob 吻合） |

口径：摘要一致证明内容一致，不等于签名、发布者认证或实现符合。规范维护权在 JuanerAI 原仓；本仓不分叉维护第二份标准。

## 2. 插件物料指纹

| 物料 | 身份 |
|---|---|
| 业务源基线 | 评估基线 `3f7817fe`（M9）；本文件随 M10 提交入库，该提交为首个含接入准备的候选身份。**宿主实际采用时应记录当时采纳提交**（不自动追随 main） |
| 固定 SDK | `vendor/pi-agent-runtime-0.4.1.tgz`，102,550 bytes，SHA256 `1ddace3a5b7ff97e80627dc4660d9f300ac402a4bfc67f43144380d3352d6da5`；依赖声明 `file:vendor/…`（`package.json`），无浮动版本 |
| 依赖锁 | `package-lock.json`，落档时 SHA256 `1a1f95cd0e3509cbbdc00fb9822ccdb72e5a007ef95061b9b322a3d61f00a705`（**采用时重算当时的值**） |
| 随包需携带 | 源码/构建产物 + `vendor/` tgz + lockfile；第三方依赖通知清单见 `package.json` dependencies（@larksuiteoapi/node-sdk、@napi-rs/canvas、jszip、pdfjs-dist、pi-agent-runtime、react、react-dom、word-extractor）；运行时 Node ≥ 24.21.0（vendored SDK engines） |

## 3. 宿主合同决策（推荐默认，待宿主任务正式确认）

| 决策 | 推荐默认 | 依据 |
|---|---|---|
| 承载形态 | **子进程 + HTTP** | `/api/health` 就绪探针（`server/index.ts`）；`scripts/e2e-feishu.ts` 已验证该模式全链路可行；`DATA_ROOT`（M10）+ `PORT`/`HOST` 使子进程装配不依赖 cwd |
| UI 呈现 | **反代同源整屏** | 前端零基址硬编码（全部相对 `/api` fetch）；后端可静态服务 `dist/` + SPA fallback |
| 模型密钥 | **宿主 env 注入** | `server/agent/model.ts` env 优先且不被磁盘回落覆盖；凭据不进配置/日志/审计 |

上述为插件侧评估推荐，非宿主决定；宿主任务确认前按 UNKNOWN 处理，不据此宣称兼容已验证。

## 4. 已具备接入面（静态核验摘要，2026-10-17 评估）

- 入口三形态：HTTP API（项目 CRUD/上传抽取/board/行动闭环/推送补救/账本投影）、`startServer(port, host, ServerOptions)` 库入口（全量依赖注入：db/dbPath/projectsDir/notifyFile/notifyStateFile/distDir/agentRunner/agentLedger/agentAuditPath/imChannel）、程序化全链路消费者（`scripts/e2e-feishu.ts`）。
- 数据根：直接执行入口经 `resolveDataRoot()`（`DATA_ROOT` env，缺省 `<cwd>/data`）；库形态经 options 显式注入。
- LLM 链：vendored SDK 0.4.1，单次保护（maxOutputTokens 8192 / modelTimeoutMs 120s / 累计不封顶）、`modelRecovery extraAttempts:1` + 一次解析修复重试、权威账本（原子写/不清账/配置签名守卫）、JSONL 安全元数据审计；SDK 触点隔离于 `server/agent/`。
- 生命周期：报告状态机 pending→extracting→done/failed、同进程单飞、重启遗留自愈、done 幂等/force 保护已决项、推送幂等键 `projectId:slug`。
- 详细文件行号证据见 2026-10-17 只读评估报告（对话交付，未入库）；行号随演进漂移，以文件为准。

## 5. 升级保护约定（引用规范 §6，未执行）

- 业务功能与中立修复在本原仓维护；宿主入口/权限/任务成果映射/装配归 JuanerAI；共享运行机制缺口归 SDK 提案。
- 首次采用与每次换物料前做最小差异表（修复位置与归属｜原仓提交/回归｜目标交付是否实际包含｜结论与缺口）。
- **不能证明新物料保留已验业务修复或数据兼容时，阻止该次新升级并保留旧验收包**；不覆盖副本、不丢补丁、不造第二业务分支；活动/UNKNOWN 任务不热换；程序回滚不等于数据回滚。
- 本仓自 M10 起无任何宿主副本修改——「宿主侧业务修复回流」状态：**尚未发生**。

## 6. 数据与安全边界（沿既有产品约定）

- 运行期数据不入库（`.gitignore`：board.db / projects/ / agent-* / notify* / im.json / prod.log）；宿主随包实例应使用自己的数据根（`DATA_ROOT` 或 options），与独立部署数据隔离。
- API 无鉴权为内网单用户既定假设（README 部署节）；宿主暴露面（owner token / 回环守卫 / 绑定策略）由宿主 Adapter 承担，插件侧不预留 hook（评估裁定可后置）。
