# 红队：M10 提案（轻量轮，2026-10-17）

范围小且源自已授权只读评估；仅攻击 load-bearing 假设，无增量用户决策。

| # | 攻击 | 裁定 |
|---|---|---|
| R1 | `DATA_ROOT` 影响面不完整：只改 board.db/projects 两处而漏 notify/audit/im → 同一实例数据分裂两处（cwd 一份、DATA_ROOT 一份） | **吸收进实现**：boot 块全部六类路径 + `composeDefaultAgent(dataRoot)` 统一从单一 `dataRoot` 派生并显式传入 `startServer`；REVIEW 走查钉死 |
| R2 | 通用 env 名 `DATA_ROOT` 在宿主共享环境撞名 | 裁定**不阻断**：该接缝仅在直接执行入口生效，子进程形态宿主独占配置子进程 env（与 PORT/HOST 同风格）；基线文档记录该前提 |
| R3 | 相对路径语义含糊（相对谁？） | **吸收**：`resolve(cwd, raw)` 钉死相对 cwd，测试覆盖 |
| R4 | 基线文档被误读为「已接入 JuanerAI」 | **吸收**：文内显式声明宿主侧装配未发生、文档是记录不是采用证明；推荐默认标注「待宿主任务正式确认」 |
| R5 | README 路线补写引入错误史实 | **吸收**：仅按 git log 与 README 既有正文归纳，不新增技术细节 |

**verdict：无 blocking 假设，进入 PRD。**
