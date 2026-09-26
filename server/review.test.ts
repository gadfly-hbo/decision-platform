import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMemberWeeklyCsv } from './report/parseCsv'
import { buildConclusions } from './rules/engine'
import { buildActionReview } from './review'
import type { ActionStore } from './actions'

const sampleCsv = readFileSync(join(__dirname, 'report/testdata', 'sample.csv'), 'utf-8')
const report = parseMemberWeeklyCsv(sampleCsv, '会员周报-2026-09-26.csv')
const conclusions = buildConclusions(report)

test('已执行/已采纳行动生成对照：thisWeek 数字可由本期数据复算', () => {
  const store: ActionStore = {
    'a-x-1': {
      status: 'executed',
      executedNote: '预算已调',
      period: '2026-09-19',
      updatedAt: 't',
      text: '核查西南加盟增长驱动',
      dimension: '加盟·A品牌-西南加盟',
    },
  }
  const review = buildActionReview(store, conclusions, report)
  expect(review).toHaveLength(1)
  const item = review[0]
  expect(item.text).toBe('核查西南加盟增长驱动')
  expect(item.status).toBe('executed')
  expect(item.executedNote).toBe('预算已调')
  expect(item.period).toBe('2026-09-19')
  // 本期西南加盟：同比 +37.8%（由样本复算）
  expect(item.thisWeek).toContain('+37.8%')
})

test('待定/驳回行动不进对照；无维度且本期无同 id 结论 → 本期无相关异动', () => {
  const store: ActionStore = {
    'a-pending-1': { status: 'pending', period: '2026-09-19', updatedAt: 't', text: '待定行动' },
    'a-rej-1': { status: 'rejected', period: '2026-09-19', updatedAt: 't', text: '驳回行动' },
    'a-ghost-1': { status: 'accepted', period: '2026-09-19', updatedAt: 't', text: '无维度旧行动' },
  }
  const review = buildActionReview(store, conclusions, report)
  expect(review).toHaveLength(1)
  expect(review[0].thisWeek).toBe('本期无相关异动')
})

test('空 store → 空对照', () => {
  expect(buildActionReview({}, conclusions, report)).toEqual([])
})

test('期次窗口：当周行动不进对照（只有往期行动显示）', () => {
  const store: ActionStore = {
    'a-this-week': { status: 'accepted', period: '2026-09-26', updatedAt: 't', text: '本周刚采纳', dimension: '加盟·A品牌-西南加盟' },
    'a-last-week': { status: 'accepted', period: '2026-09-19', updatedAt: 't', text: '上周采纳', dimension: '加盟·A品牌-西南加盟' },
  }
  const review = buildActionReview(store, conclusions, report)
  expect(review).toHaveLength(1)
  expect(review[0].text).toBe('上周采纳')
})

test('指标口径随行动所属结论：交叉信号（购买人数）行动显示人数口径', () => {
  const cross = conclusions.find((c) => c.id.startsWith('c-cross-'))!
  const store: ActionStore = {
    [cross.actions[0].id]: { status: 'executed', period: '2026-09-19', updatedAt: 't', text: '核查转化链路', dimension: cross.dimension },
  }
  const review = buildActionReview(store, conclusions, report)
  expect(review[0].thisWeek).toContain('会员购买人数')
  expect(review[0].thisWeek).not.toContain('万')
})

test('空 period 记录（演示期落库的脏数据）不进对照', () => {
  const store: ActionStore = {
    'a-dirty': { status: 'accepted', period: '', updatedAt: 't', text: '演示期脏数据' },
  }
  expect(buildActionReview(store, conclusions, report)).toEqual([])
})
