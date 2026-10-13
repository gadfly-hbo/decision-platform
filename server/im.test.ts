import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeBoardDb, createActionItem, createProject, getActionItem, openBoardDb } from './db'
import { readImConfig, buildApprovalCards, handleApprovalCallback } from './im'
import type { BoardView } from '../src/data/types'

let dir = ''
let db: ReturnType<typeof openBoardDb>
let projectId = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-im-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  db = openBoardDb(join(dir, `im-${Date.now()}-${Math.random().toString(36).slice(2)}.db`))
  projectId = createProject(db, { title: '回调项目' }).id
})
afterEach(() => closeBoardDb(db))

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

/* ---- 卡片模型（M5：审批对象 = 行动项）---- */

function viewOf(items: BoardView['actionItems'], over: Partial<BoardView> = {}): BoardView {
  return {
    title: '决策看板',
    lede: 'x',
    project: { id: 'p1', title: '测试项目', purpose: '' },
    reports: [],
    actionItems: items,
    stats: { suggested: 0, adopted: 0, dismissed: 0, manual: 0 },
    notify: { configured: true },
    modelChain: { available: true, providers: [] },
    isDemo: false,
    ...over,
  }
}

const LONG_QUOTE = '会员复购率由 12% 降至 9%，复购会员贡献销售额占比 48%，沉睡会员规模连续四周扩大，报告中给出的召回窗口估计为三十天以内'

const cardsFixture = viewOf([
  {
    id: 'i-high',
    status: 'suggested',
    priority: 'high',
    evidenceLevel: '逻辑推断',
    confidence: 0.55,
    title: '高优先级行动项',
    rationale: '报告建议',
    expectedImpact: '影响一',
    reportId: 1,
    evidence: { facts: [{ text: '复购率下滑', quote: '会员复购率由 12% 降至 9%' }], level: '逻辑推断', reasoning: 'r' },
  },
  {
    id: 'i-data',
    status: 'suggested',
    priority: 'medium',
    evidenceLevel: '数据支撑',
    confidence: 0.92,
    title: '数据级行动项',
    rationale: '报告数据支撑',
    expectedImpact: '影响二',
    reportId: 1,
    evidence: { facts: [{ text: '长引用事实', quote: LONG_QUOTE }], level: '数据支撑', reasoning: 'r' },
  },
  {
    id: 'i-both',
    status: 'suggested',
    priority: 'high',
    evidenceLevel: '数据支撑',
    confidence: 0.94,
    title: '高优且数据级',
    rationale: '双条件',
    reportId: 2,
    evidence: { facts: [{ text: '仅说明无引用' }], level: '数据支撑', reasoning: 'r' },
  },
  { id: 'i-low', status: 'suggested', priority: 'low', evidenceLevel: '经验假设', confidence: 0.3, title: '低优经验项', rationale: '走文本摘要', reportId: 1 },
  { id: 'i-adopted', status: 'adopted', priority: 'high', evidenceLevel: '数据支撑', confidence: 0.9, title: '已采纳不再成卡', rationale: 'x', reportId: 1 },
] as unknown as BoardView['actionItems'])

test('buildApprovalCards：suggested 且（高优 或 证据级=数据支撑）成卡；字段含 itemId/标题/依据/置信度', () => {
  const cards = buildApprovalCards(cardsFixture)
  expect(cards.map((c) => c.itemId)).toEqual(['i-high', 'i-data', 'i-both'])
  expect(cards[0]).toMatchObject({ itemId: 'i-high', title: '高优先级行动项', rationale: '报告建议', confidence: 0.55, evidenceLevel: '逻辑推断' })
  expect(cards[1].confidence).toBe(0.92)
})

test('buildApprovalCards：证据摘要 = top fact 引用原文（截断 ~60 字）+ 说明 + 预期效果（契约 2.11）', () => {
  const cards = buildApprovalCards(cardsFixture)
  expect(cards[0]).toMatchObject({
    topFactQuote: '会员复购率由 12% 降至 9%',
    topFactText: '复购率下滑',
    expectedImpact: '影响一',
  })
  // 超长引用截断为 60 字 + 省略号，不全文塞卡
  expect(cards[1].topFactQuote).toBe(`${LONG_QUOTE.slice(0, 60)}…`)
  expect(cards[1].topFactQuote!.length).toBeLessThanOrEqual(61)
  // 无引用 fact：仅带说明，不伪造引用
  expect(cards[2].topFactQuote).toBeUndefined()
  expect(cards[2].topFactText).toBe('仅说明无引用')
})

test('buildApprovalCards：reportId 过滤限定单报告（推送漏斗按报告逐轮发卡）', () => {
  expect(buildApprovalCards(cardsFixture, { reportId: 1 }).map((c) => c.itemId)).toEqual(['i-high', 'i-data'])
  expect(buildApprovalCards(cardsFixture, { reportId: 2 }).map((c) => c.itemId)).toEqual(['i-both'])
  expect(buildApprovalCards(cardsFixture, { reportId: 99 })).toEqual([])
})

test('buildApprovalCards：演示态不成卡（演示不冒充真实）', () => {
  expect(buildApprovalCards({ ...cardsFixture, isDemo: true })).toEqual([])
})

/* ---- 回调处理（先到先得，幂等；board.db 直写）---- */

const payload = { itemId: 'i-1', decision: 'accept' as const, operatorName: '张三' }

function seedSuggested(title: string): string {
  return createActionItem(db, {
    projectId,
    sourceKind: 'manual',
    reportId: null,
    title,
    rationale: 'x',
    scene: null,
    lifecycle: null,
    expectedImpact: '待评估',
    priority: 'medium',
    effort: 'medium',
    confidence: null,
    evidence: { facts: [], level: '经验假设', reasoning: 'x' },
  })
}

test('accept → adopted 留痕 via=card；回执含标题', () => {
  const id = createActionItem(db, {
    projectId,
    sourceKind: 'manual',
    reportId: null,
    title: '上线会员日活动',
    rationale: '一线观察',
    scene: null,
    lifecycle: null,
    expectedImpact: '待评估',
    priority: 'high',
    effort: 'medium',
    confidence: null,
    evidence: { facts: [], level: '经验假设', reasoning: '一线观察' },
  })
  const out = handleApprovalCallback({ ...payload, itemId: id }, { db })
  expect(out.applied).toBe(true)
  expect(out.reply).toBe('已采纳：上线会员日活动')
  expect(getActionItem(db, id)).toMatchObject({ status: 'adopted', decidedBy: '张三', decidedVia: 'card' })
})

test('reject → dismissed 且理由落卡片默认值（看板可补填，G10）', () => {
  const id = createActionItem(db, {
    projectId,
    sourceKind: 'manual',
    reportId: null,
    title: '调整渠道预算',
    rationale: 'x',
    scene: null,
    lifecycle: null,
    expectedImpact: '待评估',
    priority: 'medium',
    effort: 'medium',
    confidence: null,
    evidence: { facts: [], level: '经验假设', reasoning: 'x' },
  })
  const out = handleApprovalCallback({ ...payload, itemId: id, decision: 'reject' }, { db })
  expect(out.applied).toBe(true)
  expect(out.reply).toBe('已驳回：调整渠道预算')
  expect(getActionItem(db, id)).toMatchObject({
    status: 'dismissed',
    dismissedReason: '卡片驳回（未填理由）',
    decidedVia: 'card',
  })
})

test('重复回调：已决项不改库，回执按首次结果提示', () => {
  const id = seedSuggested('先驳回再点采纳')
  const first = handleApprovalCallback({ ...payload, itemId: id, decision: 'reject' }, { db })
  expect(first.applied).toBe(true)
  const second = handleApprovalCallback({ ...payload, itemId: id, decision: 'accept' }, { db })
  expect(second.applied).toBe(false)
  expect(second.reply).toBe('已按首次点击结果处理：驳回')
  expect(getActionItem(db, id)?.status).toBe('dismissed')
})

test('行动项不存在（过期卡片）：不落库，回执提示到看板查看', () => {
  const out = handleApprovalCallback({ ...payload, itemId: 'ghost' }, { db })
  expect(out.applied).toBe(false)
  expect(out.reply).toBe('该卡片已处理或已过期，请到看板查看最新状态。')
})

test('非法载荷（缺字段/decision 枚举外）拒绝且不落库', () => {
  for (const bad of [null, {}, { itemId: 'x' }, { ...payload, decision: 'maybe' }, { ...payload, operatorName: '' }]) {
    const out = handleApprovalCallback(bad, { db })
    expect(out.applied).toBe(false)
    expect(out.reply).toBe('审批请求无效（载荷不完整）')
  }
})
