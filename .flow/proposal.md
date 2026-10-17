# 提案：M10 — JuanerAI 接入准备（插件侧：DATA_ROOT + 集成基线 + 路线同步）

日期：2026-10-17。来源：JuanerAI 接入差距只读评估 v0.4（规范包 `6756546a` 已核验，散件包 SHA256 `74077191…`）；用户授权「三项全做 + 宿主决策记录为推荐默认 + 两拍发布」。

## 评估结论锚点（已证实事实）

- 插件侧**必须项为零**：HTTP API + `startServer()` 库入口 + e2e 程序化消费者已完整表达业务语义；SDK 链（vendored 0.4.1）合规；无共享机制缺口。
- 现状唯一装配摩擦：运行数据根 = `process.cwd()/data`（`server/index.ts:470-492` 五处派生），直接进程形态下宿主须控制 cwd 才能定位数据——隐式耦合；库形态虽可经 `ServerOptions` 显式注入，但无进程级环境变量接缝。
- 集成身份未落档：未来宿主按规范 §6「首次建立升级基线」需要源提交／固定物料指纹，当前无处可查。
- README 路线节停在 M6，与 git 历史（M7/M8/M9 已交付）漂移。

## 已确认决策（用户三项）

1. **`DATA_ROOT` 环境变量显式数据根**：boot 块统一派生全部六类运行数据路径（board.db / projects / im.json / notify.json / notify-state.json / agent-audit.jsonl + `composeDefaultAgent(dataRoot)`），宿主装配不再依赖 cwd 控制；缺省行为不变（`<cwd>/data`）。
2. **集成基线记录 `docs/juanerai-integration-baseline.md`**：规范身份（PR #93 / `6756546a` / 散件包 SHA）、插件物料指纹（源提交、vendored tgz SHA、lockfile SHA）、宿主三项合同决策记录为**推荐默认（待宿主任务正式确认）**、显式声明「宿主侧装配未发生」。
3. **README 路线节同步**：补 M7–M9 已交付条目、M10 当前条目；开发节记录 `DATA_ROOT`。

## 约束

- 库函数 `startServer` 不读环境变量（显式 options 优先的既有设计不变）；`DATA_ROOT` 仅在直接执行入口（main-module 守卫内）生效。
- 独立运行路径零变化：不设 `DATA_ROOT` 时全部行为与现状逐字节等价。
- 不做（可后置项维持后置）：API 鉴权 hook、取消端点、plist 参数化、宿主侧任何装配、SDK 升级或版本统一。
