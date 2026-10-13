# M8 任务拆分（单片）

- [x] 1. 抽取输出容错：normalize 纯函数 + runText 切换 + ≤6 条上限 + 修复重试一次（TDD）

## 1
### What to build
见 `.flow/prd.md` M8 节四条。验收：
- [ ] normalize：围栏/说明文字/字符串内 ]/注释/尾逗号/截断失败全有测试
- [ ] extract：围栏回复成功、说明文字包裹成功、截断→重试成功（断言重试 prompt 内容）、两次皆败抛错、同 taskId 两 run 账本不 CONFIGURATION_CHANGED
- [ ] `npm run verify` 绿
