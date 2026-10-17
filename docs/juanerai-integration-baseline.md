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
| 业务源基线 | 评估基线 `3f7817fe`（M9）；**当前独立版候选 = main @ `9d4d776`**（M10 + DP-RECOVERY-01 回流，见 §5.1）；**采用时以实际提供物料为准**并记录，不追随 main |
| 已验收集成物料 012 | 源码 manifest SHA256 `28ce87cbae9f8aa47db8ff85025b9a375d752aac21b4fa9cc6b22302750e387a`（3522 项）、证据 manifest `58eaa98e…`（405 项）、资源摘要 `0c2ee1e9…`；宿主物料校验器硬钉固定上游 `c11f8da8d8db3b2d5ae2424941a24307471ad972`；插件 SDK 0.4.1 / 宿主 SDK 0.5.1 各自固定 |
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
- LLM 链：vendored SDK 0.4.1，单次保护（maxOutputTokens 8192 / modelTimeoutMs 120s / 累计不封顶）；**一次逻辑抽取 ≤2 次模型准入，备用与格式修复共享一次恢复机会（DP-RECOVERY-01，§5.1）**；权威账本（原子写/不清账/配置签名守卫）、JSONL 安全元数据审计；SDK 触点隔离于 `server/agent/`；装配入口双形态——`composeDefaultAgent`（独立默认，读既有配置）与 `composeAgent`（显式候选/授权，不发现凭据，供宿主装配）。
- 生命周期：报告状态机 pending→extracting→done/failed、同进程单飞、重启遗留自愈、done 幂等/force 保护已决项、推送幂等键 `projectId:slug`。
- 详细文件行号证据见 2026-10-17 只读评估报告（对话交付，未入库）；行号随演进漂移，以文件为准。

## 5. 升级保护约定（引用规范 §6）

- 业务功能与中立修复在本原仓维护；宿主入口/权限/任务成果映射/装配归 JuanerAI；共享运行机制缺口归 SDK 提案。
- 首次采用与每次换物料前做最小差异表（修复位置与归属｜原仓提交/回归｜目标交付是否实际包含｜结论与缺口）。
- **不能证明新物料保留已验业务修复或数据兼容时，阻止该次新升级并保留旧验收包**；不覆盖副本、不丢补丁、不造第二业务分支；活动/UNKNOWN 任务不热换；程序回滚不等于数据回滚。

### 5.1 接入后回流差异表（2026-10-17 同步检查；宿主接入 = PR #100 `f803ddcf` / PR #101 `081031af`，固定 012 已获产品接受、工程接受带具名风险）

| 修复/接缝 | 归属 | 原仓维护提交 | 独立版（main） | 集成物料 012 | 验证证据 | 状态 |
|---|---|---|---|---|---|---|
| **DP-RECOVERY-01**：一次逻辑抽取 ≤2 次模型准入（备用与格式修复共享一次恢复，不叠加第三/四次）；每次准入/发布经授权+账本+审计；同 taskId 历史累计与 UNKNOWN 预留不被清除；并发额度隔离；**`composeAgent` 显式装配**（不发现磁盘凭据，宿主入口）与 `composeDefaultAgent` 独立默认入口并存兼容 | 插件中立修复 | 原身份 `c11f8da`（保留于 `work/macbook/decision-platform-recovery-20261017` 分支）；main 回流 = `9d4d776`（cherry-pick -x） | ✅ `9d4d776` 起，下一次独立交付自动包含 | ✅ 宿主 `materials.ts` 硬校验 `sourceCommit=c11f8da` + 012 源码 manifest `28ce87cb…` + 收口记录「原仓修复归属不变」 | 修正前因果 RED：新 9 项测试 7 PASS/2 FAIL（第三/四次请求本应阻断却成功，`upstream-compose-red.log`，Mini 持久根）+ 宿主合成反例 `recovery-synthetic-002`（4 次准入、账本 modelCalls=4）；修正后：宿主 029 合成 1/1/1/2/2/2 准入账本 + 032 portable 4882 PASS/0 FAIL；本轮 main `npm run verify` 19 文件/204 测试/build ✓（Node 24.21.0，本机亲自执行） | **原仓与目标均证实包含** |
| 浏览器五项修补：汇报退出焦点、UNKNOWN 材料提交保护、原文件名/版本展示投影、发送按钮读屏名称、执行详情抽屉瞬态视口 | 宿主专属（host 嵌入层 `apps/browser/decision-platform/` 与 adapter；宿主 reference 副本与本仓 main 前端**逐字节一致**，未改插件源码） | 不适用 | N/A（无插件侧改动） | ✅ 于 012 宿主层内 | 宿主 `browser-repair-authorizations.md` 逐项授权 + 因果 RED 先行；本轮 reference diff 全 SAME（唯一 host-only 文件 `useBoardStore.d.ts` 为宿主自生成） | **宿主专属** |
| 宿主 extraction-scope（材料/任务校验、recipient 钉定）、账本只读投影、成果副本与回执、UNKNOWN 材料准入 | 宿主专属 | 不适用 | N/A | ✅ | 宿主 `extraction-scope.ts` 明示「Wrap c11f8da's runner…SDK objects stay here」——包装不复制 | **宿主专属** |
| SDK 版本统一 | 共享机制（按标准不统一） | 插件 vendored 0.4.1 不变 | 不升级 | 同 012（宿主 0.5.1 独立固定） | 两侧收口记录 | **无回流项** |

**证据缺口与 UNKNOWN（如实保留，不补造）**：① Mini 持久证据根原件（`upstream-compose-red.log`、`recovery-synthetic-002`、012 快照、`user-decisions-012.json` 等）MacBook 无副本——身份与结论以宿主仓固定提交内记录为准；② 原独立 Validator **BLOCKED**、`R-012-HISTORICAL-RED`、`F-ROLE-012`（danger-full-access / approval never / 无强制只读沙箱具名例外）按原样保留，仅限 012 范围；③ 真实 Provider 质量、正式安装发行、干净机、生产采用：未执行/未授权；④ 宿主 `materials.ts` 校验字符串钉 `c11f8da`——宿主未来若改采 main 新提交（`9d4d776`+），需其侧更新校验并按规范 §6 复验包含性；**main 不自动替换已验收 012，不改绑旧数据/会话/账本**。

**独立版行为核查结论（本轮只读核对，无缺陷，未改动）**：上传后异步状态机（pending→extracting→done/failed，无 runner 落 failed「模型不可用」）、重复 POST（同名上传=force 重抽保护已决项；done 幂等跳过；进程内单飞 + c11f8da 后 runner 级同 taskId 拒绝）、丢回执查回（推送幂等键 `projectId:slug` + 手动补救端点 + board 读回）、看板 GET 的写效果（`scanReports` 注册新文件与 extracting 自愈复位，为 M6 评审既定行为非缺陷，宿主以自有 ingress/store 适配，不改独立版语义）、构建入口模块边界（main-module 守卫使测试/库导入不监听）。

## 6. 数据与安全边界（沿既有产品约定）

- 运行期数据不入库（`.gitignore`：board.db / projects/ / agent-* / notify* / im.json / prod.log）；宿主随包实例应使用自己的数据根（`DATA_ROOT` 或 options），与独立部署数据隔离。
- API 无鉴权为内网单用户既定假设（README 部署节）；宿主暴露面（owner token / 回环守卫 / 绑定策略）由宿主 Adapter 承担，插件侧不预留 hook（评估裁定可后置）。
