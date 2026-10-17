# M10 任务拆分（单片）

- [x] 1. DATA_ROOT 显式数据根：`resolveDataRoot` 纯函数 + boot 块六类路径统一派生（TDD）
- [x] 2. 集成基线记录 `docs/juanerai-integration-baseline.md`
- [x] 3. README：开发节 env 说明 + 路线节补 M7–M10

## 验收

- [x] `server/data-root.test.ts` 四用例绿（缺省/绝对/相对/空白）
- [x] boot 块 board.db / projects / im.json / notify.json / notify-state.json / agent-audit.jsonl 及 `composeDefaultAgent` 全部由同一 `dataRoot` 派生（REVIEW 走查，红队 R1；评审者核毕：守卫块内 process.cwd() 出现 0 次）
- [x] 不设 `DATA_ROOT` 时路径与现状逐字节等价（评审者对照 `git show 3f7817fe` 核毕；agentAuditPath 恒传在缺省下恒等、DATA_ROOT 下更正确）
- [x] 基线文档含：规范身份（PR #93 / `6756546a` / 包 SHA）、物料指纹（源提交 / vendor tgz SHA / lockfile SHA）、宿主三项推荐默认（标注待确认）、「宿主侧未发生」声明（指纹经评审者 shasum 实测复核一致）
- [x] README 路线与 git 历史一致（M7/M8/M9 已交付 + M10 当前；评审者核对提交主题一一对应）
- [x] `npm run verify` 绿（tsc + 18 文件 195 测试 + build；评审者独立复跑属实）
