import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readImConfig,
  buildApprovalCards,
  handleApprovalCallback,
  type ApprovalCallbackPayload,
} from './im'
import type { ActionStore } from './actions'
import type { DashboardData } from '../src/data/types'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-im-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/* ---- im.json 配置读取 ---- */

test('readImConfig：合法双平台；缺失/损坏/空数组/字段缺失 → null', () => {
  expect(readImConfig(join(dir, 'missing.json'))).toBeNull()
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{oops', 'utf-8')
  expect(readImConfig(broken)).toBeNull()
  const empty = join(dir, 'empty.json')
  writeFileSync(empty, JSON.stringify({ platforms: [] }), 'utf-8')
  expect(readImConfig(empty)).toBeNull()
  const noField = join(dir, 'nofield.json')
  writeFileSync(noField, JSON.stringify({ platforms: [{ platform: 'feishu', appId: 'a' }] }), 'utf-8')
  expect(readImConfig(noField)).toBeNull()

  const good = join(dir, 'good.json')
  writeFileSync(
    good,
    JSON.stringify({
      platforms: [
        { platform: 'feishu', appId: 'cli_a', appSecret: 's1', approverUserId: 'ou_1', approverName: '张三' },
        { platform: 'dingtalk', appId: 'ding_a', appSecret: 's2', approverUserId: 'u2', approverName: '李四' },
      ],
    }),
    'utf-8',
  )
  expect(readImConfig(good)?.platforms).toHaveLength(2)
  expect(readImConfig(good)?.platforms[0]).toMatchObject({ platform: 'feishu', approverName: '张三' })
})

/* ---- 卡片模型（KA5：结论全文 + 归因 top3 + 关键数字）---- */

const data = {
  period: '2026-09-26',
  isDemo: false,
  conclusions: [
    {
      id: 'c-divergence',
      severity: 'high',
      title: '会员零售额同比 +8.8%，与大盘零售额 -5.9% 背离',
      summary: '会员零售额逆势增长，与大盘方向相反，需确认增长质量。',
      window: '09-12 ~ 09-25',
      updatedAt: 't',
      metricIds: ['memberSales'],
      derivation: [],
      breakdown: [
        { dimension: '加盟·A品牌-西南加盟', contribution: 42.1, value: 100, delta: '+38%' },
        { dimension: '直营·A品牌-华东直营', contribution: -18.6, value: 50, delta: '-12%' },
        { dimension: '加盟·A品牌-华南加盟', contribution: 9.3, value: 30, delta: '+6%' },
        { dimension: '直营·A品牌-华北直营', contribution: -4.2, value: 20, delta: '-3%' },
      ],
      actions: [
        { id: 'a-divergence-1', conclusionId: 'c-divergence', text: '核查会员逆势增长的结构质量', impact: '明确本周会员运营的资源加减方向' },
      ],
    },
    {
      id: 'c-medium',
      severity: 'medium',
      title: '中优结论不入卡片',
      summary: 'x',
      window: 'w',
      updatedAt: 't',
      metricIds: [],
      derivation: [],
      breakdown: [],
      actions: [{ id: 'a-medium-1', conclusionId: 'c-medium', text: 't', impact: 'i' }],
    },
    {
      id: 'c-high-noaction',
      severity: 'high',
      title: '无行动高优结论（只进摘要不进卡片）',
      summary: 'x',
      window: 'w',
      updatedAt: 't',
      metricIds: [],
      derivation: [],
      breakdown: [],
      actions: [],
    },
    {
      id: 'c-high-thin',
      severity: 'high',
      title: '归因不足 3 行的高优结论',
      summary: 'y',
      window: 'w',
      updatedAt: 't',
      metricIds: [],
      derivation: [],
      breakdown: [{ dimension: '加盟·A品牌-西南加盟', contribution: 5, value: 10 }],
      actions: [{ id: 'a-thin-1', conclusionId: 'c-high-thin', text: 't2', impact: 'i2' }],
    },
  ],
} as unknown as DashboardData

test('buildApprovalCards：仅 high 且有行动的结论成卡；归因按 |贡献| 取 top3；期次/窗口携带', () => {
  const cards = buildApprovalCards(data)
  expect(cards.map((c) => c.conclusionId)).toEqual(['c-divergence', 'c-high-thin'])

  const first = cards[0]
  expect(first.title).toContain('背离')
  expect(first.summary).toContain('逆势增长')
  expect(first.window).toBe('09-12 ~ 09-25')
  expect(first.period).toBe('2026-09-26')
  expect(first.attribution.map((a) => a.dimension)).toEqual([
    '加盟·A品牌-西南加盟',
    '直营·A品牌-华东直营',
    '加盟·A品牌-华南加盟',
  ])
  expect(first.actions).toEqual([
    { actionId: 'a-divergence-1', text: '核查会员逆势增长的结构质量', impact: '明确本周会员运营的资源加减方向' },
  ])

  expect(cards[1].attribution).toHaveLength(1)
})

/* ---- 回调处理（先到先得，幂等，GRILL 决议 3）---- */

const validPayload: ApprovalCallbackPayload = {
  conclusionId: 'c-divergence',
  actionId: 'a-divergence-1',
  decision: 'accept',
  operatorName: '张三',
  period: '2026-09-26',
}

test('handleApprovalCallback：accept/reject 落库留痕 via=card；记录不存在视为 pending 可审', () => {
  const store: ActionStore = {}
  const accept = handleApprovalCallback(validPayload, { store, period: '2026-09-26', currentPeriod: '2026-09-26', now: '2026-09-27T08:00:00Z' })
  expect(accept.applied).toBe(true)
  expect(accept.store['a-divergence-1']).toMatchObject({
    status: 'accepted',
    decidedBy: '张三',
    decidedVia: 'card',
    decidedAt: '2026-09-27T08:00:00Z',
    period: '2026-09-26',
  })
  expect(accept.reply).toContain('已采纳')

  const reject = handleApprovalCallback(
    { ...validPayload, actionId: 'a-divergence-2', decision: 'reject' },
    { store: accept.store, period: '2026-09-26', currentPeriod: '2026-09-26', now: '2026-09-27T08:01:00Z' },
  )
  expect(reject.store['a-divergence-2']).toMatchObject({ status: 'rejected', decidedBy: '张三' })
  expect(reject.reply).toContain('已驳回')
})

test('handleApprovalCallback：旧期次卡片（period 落后当前期次）不落库，回执提示过期（proposal §8）', () => {
  const store: ActionStore = {}
  const stale = handleApprovalCallback(validPayload, { store, period: '2026-09-26', currentPeriod: '2026-10-03', now: 't' })
  expect(stale.applied).toBe(false)
  expect(stale.store).toBe(store)
  expect(stale.reply).toContain('已过期')
  expect(stale.reply).toContain('2026-10-03')
})

test('handleApprovalCallback：重复回调/已被 PC 处理 → 不改 store，回执提示已处理', () => {
  const store: ActionStore = {
    'a-divergence-1': { status: 'accepted', period: '2026-09-26', updatedAt: 't', decidedBy: '张三', decidedAt: 't', decidedVia: 'card' },
  }
  const again = handleApprovalCallback(validPayload, { store, period: '2026-09-26', currentPeriod: '2026-09-26', now: 't2' })
  expect(again.applied).toBe(false)
  expect(again.store).toBe(store)
  expect(again.reply).toContain('已处理')

  const pcDecided: ActionStore = {
    'a-divergence-1': { status: 'rejected', period: '2026-09-26', updatedAt: 't', decidedAt: 't', decidedVia: 'pc' },
  }
  const late = handleApprovalCallback(validPayload, { store: pcDecided, period: '2026-09-26', currentPeriod: '2026-09-26', now: 't2' })
  expect(late.applied).toBe(false)
  expect(late.reply).toContain('已处理')
})

test('handleApprovalCallback：非法载荷（形状/decision 枚举/缺 period）拒绝且不落库', () => {
  const store: ActionStore = {}
  for (const bad of [
    null,
    {},
    { ...validPayload, decision: 'maybe' },
    { ...validPayload, actionId: 42 },
    { ...validPayload, operatorName: '' },
    { ...validPayload, period: '' },
  ]) {
    const out = handleApprovalCallback(bad, { store, period: 'p', currentPeriod: 'p', now: 't' })
    expect(out.applied).toBe(false)
    expect(out.store).toBe(store)
    expect(out.reply).toBeTruthy()
  }
})
