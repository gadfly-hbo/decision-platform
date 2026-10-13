# M6 任务拆分（tracer-bullet 垂直切片）

依据：`.flow/prd.md`（M6 + G1'-G7'）+ `.flow/ui-contract.md` v5。

- [x] 1. 项目存储与项目 API（schema 重建/CRUD/作用域/旧端点移除）
- [x] 2. 上传与抽取触发（base64 上传/同名覆盖 force/调度器退役/事件驱动推送/项目级校准）
- [x] 3. 前端项目化（项目导航/上传/空态/演示退役/localStorage/board 切换）
- [x] 4. 收尾（README/脚本核对/e2e 适配）

依赖：1→2→3→4；每片完成 = `npm run verify` 绿 + 片内验收可演示。

## 1. 项目存储与项目 API
### What to build
`projects` 表（uuid/title/purpose/时间戳）；schema 版本标记：打开库时无 projects 表（M5 旧库）→ 删文件重建（用户决策：清空）。reports/action_items(manual) 挂 project_id（外键级联）；`POST/GET/PATCH/DELETE /api/projects`（GET 列表含每项目行动项统计；DELETE 事务级联+`data/projects/<id>/` 目录硬删）；`GET /api/projects/:id/board`（BoardView+project 元信息+项目内 reports/items）；行动项/任务/反馈既有端点校验项目归属（跨项目 id 404）；移除 `GET /api/dashboard`、全局 `/api/reports*`（旧 reports 端点功能并入项目端点，extract 移片 2）；`startPushScheduler` 调度空壳保留到片 2 移除。
### Acceptance criteria
- [ ] 旧库重建测试（预置 M5 形态库文件→打开→新 schema 空 projects）
- [ ] CRUD/硬删级联（库+目录）/统计列表测试；404/400 负向
- [ ] board 聚合项目隔离测试（A 项目 id 不出现在 B 项目 board；跨项目 PATCH 404）
- [ ] 旧端点移除后 404；`npm run verify` 绿
### Blocked by
None

## 2. 上传与抽取触发
### What to build
`POST /api/projects/:id/reports`：JSON base64（filename+content），≤2MB、.md/.txt、UTF-8；写 `data/projects/<projectId>/reports/<filename>`→注册→**异步触发抽取**（复用状态机与 runner 注入）；同名覆盖=force 重抽（G3 保护）；多文件=逐份独立结果。`POST /api/projects/:id/reports/extract`（slug/force）。`loadCalibrationContext` 加 projectId 过滤。推送：抽取完成处直接触发漏斗（摘要带【项目名】、幂等键 `projectId:slug`、手动重推 body 可带 projectId）；**移除 startPushScheduler 与全局扫描**。
### Acceptance criteria
- [ ] 上传测试：合法落盘+pending+异步抽取 done；超限/类型/空内容 400；多文件单败不连锁；同名覆盖 force 保护已决项
- [ ] 校准项目级过滤测试（B 项目驳回理由不进 A 项目 prompt）
- [ ] 推送测试：抽取完成触发一次（幂等）、摘要含项目名、手动重推定向项目；调度器移除后无定时器（close 干净）
- [ ] `npm run verify` 绿
### Blocked by
- 1

## 3. 前端项目化
### What to build
UI 契约 v5：S-L 项目导航（新建 inline 表单/列表含计数与活动/编辑/删除确认弹窗 S14/空态逐字/当前高亮/localStorage `dp.activeProjectId` 与删除回退）；S1 项目名+purpose+统计含报告数；S1b「上传报告」多文件+项目报告列表（四态/重新生成两段式）；无项目引导卡（02 区）；**演示态退役**（demo.ts/相关测试/文案删除，fetch 失败改错误态不回退演示）；数据层切 `GET /api/projects/:id/board`、上传/项目操作 API 封装；S2-S5/S-R/驳回弹窗不动。
### Acceptance criteria
- [ ] 组件测试：项目切换数据源、新建/编辑/删除弹窗（文案逐字+焦点安全位）、上传多文件状态流转、无项目空态、演示态不出现（禁用词断言）
- [ ] 闭环回归（M5 用例改项目夹具后全过）；`npm run verify` 绿
### Blocked by
- 2

## 4. 收尾
README 重写（项目化用法/上传/架构/部署 data/projects 不入库）；`启动决策看板.command`/dev-all 冒烟；scripts/e2e-feishu.ts 适配项目 API；.gitignore 补 data/projects/。
### Acceptance criteria
- [ ] README 与行为一致；dev:all 冒烟（起服务 curl 项目 CRUD+上传+board）；e2e 脚本类型通过；`npm run verify` 绿
### Blocked by
- 3
