# M7 任务拆分

依据：`.flow/prd.md`（M7 + G1''-G4''）+ `.flow/ui-contract.md` v6（2.18 S15）。

- [x] 1. 汇报模式前端实现（入口/汇总页/逐项页/键盘流/会中拍板/状态与测试）
- [x] 2. 收尾（README 补汇报模式 + dev:all 冒烟）

依赖：1→2。

## 1. 汇报模式前端实现
### What to build
按契约 2.18 六小节实现 PresentationMode（+PresSummaryPage/PresItemPage 子结构，DismissReasonDialog 大字变体）：S1 入口按钮与 P 快捷键、Fullscreen 降级、汇总页（统计/分布条/议程直达/范围切换/空议程）、逐项页（信息结构/键位 ←/→/Home/End/G/A/D/两层 Esc/采纳 800ms 自动前进/驳回大字弹窗/留痕行/人工项）、操作共享 useBoardStore（G4''）、`.pres-*` 样式与排版档位（3 米可读）、fade ≤80ms（reduced-motion 禁用）。
### Acceptance criteria
- [ ] 组件测试：入口/Esc 焦点返回、汇总统计与分布条计数、议程排序直达、逐项信息结构（四级证据夹具）、全键位、A 采纳调用与前进、D 弹窗逐字校验与两层 Esc、留痕行、空议程文案、人工项、失败 aria-live 停留
- [ ] 工作台回归零改动全绿；`npm run verify` 绿
### Blocked by
None

## 2. 收尾
README 使用步骤补「会议汇报模式」（入口/键位/会中拍板）；dev:all 冒烟（起服务+浏览器手动走查记录：进入模式翻条拍板退出）。
### Acceptance criteria
- [ ] README 与行为一致；冒烟走查记录；`npm run verify` 绿
### Blocked by
- 1
