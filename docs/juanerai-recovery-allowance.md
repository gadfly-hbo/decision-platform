# DP-RECOVERY-01：一次逻辑抽取共享一次恢复机会

用户已授权原仓隔离修正；基线8ae652ce，SDK0.4.1和锁不变。此为固定候选修正，无真实Provider/数据或发布。

## 要求

一次runner.runExtraction范围内，模型主请求与所有备用/格式修复合计最多2次准入。首请求成功不增加调用；坏JSON可用尚未花费的恢复机会；主失败已用备用后再遇坏JSON不得发第三次。同一taskId的历史用量不清零，并发不同任务额度独立；同任务在途调用不得重置额度。每次准入和发布继续调用注入的宿主授权；未知预留保留。

## 装配

复用原createExtractionRunner及SDK重试/账本，不复制解析与抽取业务。独立默认入口仍读取其既有配置；新增显式composeAgent入口由调用方传实际候选/授权，供JuanerAI不发现磁盘凭据地装配同一业务链。通过一次逻辑抽取的异步作用域共享准入计数，实际模型请求仍经SDK原授权/计量/审计。该内存计数只限制本次自动恢复，不是新账本、持久许可、恢复凭证或并发平台；手动续作是否安全由既有上层核清。

## 验证

server/agent/compose.test.ts覆盖真实SDK codec、已批准四请求反例、格式修复后备用第三请求、同task历史累计、并发隔离、重复调用和撤权。原18项抽取/模型/账本基线PASS。新9项在增加准入保护前7PASS/2FAIL，两个失败均因本应阻断的第三/第四请求最终产生成功结果；原始日志在Mini本任务持久证据根upstream-compose-red.log。

尚未独立验证、未发布、未作为宿主完成接入；候选最终结果另追加。

## 本轮作者验证（2026-10-17）

修正后27项受影响检查通过。完整npm run verify在Node25.9.0、命令局部NODE_OPTIONS=--no-experimental-webstorage下：TypeScript通过，19文件204测试通过，Vite生产构建通过。原生Node WebStorage与jsdom的localStorage冲突在未修改8ae652ce的原测试也复现；仅关闭该Node实验特性使jsdom负责模拟Storage，未改前端/测试断言。保留原失败、3处新增测试可空值类型错误及后续通过，证据分别upstream-full-verify-001/002/003.log、upstream-original-webstorage-failure.log。

此为Mini隔离测试副本的作者结果，未启动MacBook服务、未调用Provider、未修改SDK/lock/数据库结构。接入原有看板UI不变；独立验证和新候选采用单独记录。
