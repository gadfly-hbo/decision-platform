import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feishuApprovalCard, feishuResultCard, startFeishuBridge, type CardActionLike, type FeishuChannelLike } from './im-feishu'
import { closeBoardDb, createActionItem, createProject, getActionItem, openBoardDb, type BoardDb } from './db'
import type { ApprovalCard } from './im'

let dir = ''
let db: BoardDb

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-imfeishu-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let projectId = ''

beforeEach(() => {
  db = openBoardDb(join(dir, `feishu-${Date.now()}-${Math.random().toString(36).slice(2)}.db`))
  projectId = createProject(db, { title: '桥接项目' }).id
})
afterEach(() => {
  try {
    closeBoardDb(db)
  } catch {
    // 落库异常用例已主动关闭；重复 close 吞掉
  }
})

const card: ApprovalCard = {
  itemId: 'item-1',
  title: '对沉睡会员发放阶梯券',
  rationale: '会员复购率由 12% 降至 9%，建议以阶梯券激活沉睡会员。',
  confidence: 0.92,
  evidenceLevel: '数据支撑',
  topFactQuote: '会员复购率由 12% 降至 9%',
  topFactText: '复购率下滑',
  expectedImpact: '30 日内复购率回升约 2pp',
}

function seedItem(title: string): string {
  return createActionItem(db, {
    projectId,
    sourceKind: 'extracted',
    reportId: null,
    title,
    rationale: '报告建议依据',
    scene: null,
    lifecycle: null,
    expectedImpact: '预期效果',
    priority: 'high',
    effort: 'medium',
    confidence: 0.92,
    evidence: { facts: [{ text: '复购率下滑', quote: '会员复购率由 12% 降至 9%' }], level: '数据支撑', reasoning: 'r' },
  })
}

test('feishuApprovalCard：schema 携带标题/依据/证据摘要（引用原文+等级+置信度）/预期效果，按钮 value 编码 itemId+decision', () => {
  const json = feishuApprovalCard(card) as {
    header: { title: { content: string } }
    elements: Array<Record<string, unknown> & { tag?: string; actions?: Array<Record<string, unknown>>; text?: { content?: string } }>
  }
  expect(json.header.title.content).toContain('对沉睡会员发放阶梯券')
  const texts = json.elements.map((e) => e.text?.content ?? '').join('\n')
  expect(texts).toContain('会员复购率由 12% 降至 9%') // 依据 + 证据摘要引用原文
  expect(texts).toContain('置信度 92%')
  expect(texts).toContain('证据等级 数据支撑')
  expect(texts).toContain('证据摘要')
  expect(texts).toContain('30 日内复购率回升约 2pp') // 预期效果（契约 2.11）
  const action = json.elements.find((e) => e.tag === 'action')
  expect(action?.actions).toHaveLength(2)
  const values = action!.actions!.map((b) => b.value)
  expect(values).toContainEqual({ itemId: 'item-1', decision: 'accept' })
  expect(values).toContainEqual({ itemId: 'item-1', decision: 'reject' })
})

test('feishuApprovalCard：无引用 fact 时不渲染证据摘要块（不伪造引用）', () => {
  const json = feishuApprovalCard({ ...card, topFactQuote: undefined }) as {
    elements: Array<Record<string, unknown> & { text?: { content?: string } }>
  }
  const texts = json.elements.map((e) => e.text?.content ?? '').join('\n')
  expect(texts).not.toContain('证据摘要')
  expect(texts).toContain('预期效果') // 其余正文不受影响
})

test('feishuResultCard：结果态文案 + 无按钮', () => {
  const json = feishuResultCard('已采纳 · 黄博') as {
    header: { title: { content: string } }
    elements: Array<Record<string, unknown> & { tag?: string; text?: { content?: string } }>
  }
  expect(json.header.title.content).toContain('已处理')
  expect(json.elements.map((e) => e.text?.content ?? '').join()).toContain('已采纳 · 黄博')
  expect(json.elements.some((e) => e.tag === 'action')).toBe(false)
})

/* ---- 桥接：cardAction → 行动项落库 → updateCard（fake channel，SDK 网络不进单测）---- */

interface Captured {
  sent: Array<{ to: string; input: { text?: string; card?: object } }>
  updated: Array<[string, object]>
  cardHandler?: (evt: CardActionLike) => void | Promise<void>
}

function makeFakeChannel(captured: Captured): FeishuChannelLike {
  return {
    send: async (to, input) => {
      captured.sent.push({ to, input })
      return { messageId: `om_${captured.sent.length}` }
    },
    updateCard: async (messageId, card) => {
      captured.updated.push([messageId, card])
    },
    on: (name, handler) => {
      if (name === 'cardAction') captured.cardHandler = handler
      return () => {}
    },
    disconnect: async () => {},
  }
}

const CONFIG = { platform: 'feishu' as const, appId: 'cli_x', appSecret: 's', approverUserId: 'ou_approver', approverName: '黄博' }

async function withBridge(captured: Captured, deps: Partial<Parameters<typeof startFeishuBridge>[0]> = {}) {
  const bridge = await startFeishuBridge({ config: CONFIG, db, channelFactory: async () => makeFakeChannel(captured), ...deps })
  return bridge
}

test('startFeishuBridge：sendApproval 发文本+卡片；cardAction 落库留痕并更新卡片；重复回调提示已按首次结果处理', async () => {
  const captured: Captured = { sent: [], updated: [] }
  const itemId = seedItem('对沉睡会员发放阶梯券')
  const bridge = await withBridge(captured)

  await bridge.sendApproval('【决策看板】行动闭环周摘要', [card])
  expect(captured.sent).toHaveLength(2) // 1 条文本摘要 + 1 张卡片
  expect(captured.sent[0].to).toBe('ou_approver')
  expect(captured.sent[0].input.text).toContain('周摘要')
  expect(captured.sent[1].input.card).toBeDefined()

  const evt = {
    messageId: 'om_9',
    operator: { openId: 'ou_approver' },
    action: { value: { itemId, decision: 'accept' }, tag: 'button' },
  }
  await captured.cardHandler!(evt)
  expect(getActionItem(db, itemId)).toMatchObject({ status: 'adopted', decidedBy: '黄博', decidedVia: 'card' })
  expect(captured.updated).toHaveLength(1)
  const replyText = JSON.stringify(captured.updated[0][1])
  expect(replyText).toContain('已采纳')
  expect(replyText).toContain('对沉睡会员发放阶梯券')

  // 重复回调（平台重试）：先到先得，不改库，卡片更新为已处理提示
  await captured.cardHandler!(evt)
  expect(getActionItem(db, itemId)?.status).toBe('adopted')
  expect(captured.updated).toHaveLength(2)
  expect(JSON.stringify(captured.updated[1][1])).toContain('已按首次点击结果处理')

  await bridge.stop()
})

test('startFeishuBridge：非法载荷回调不落库', async () => {
  const captured: Captured = { sent: [], updated: [] }
  seedItem('任意行动项')
  const bridge = await withBridge(captured)
  await captured.cardHandler!({ messageId: 'om_1', operator: { openId: 'ou_approver' }, action: { value: { decision: 'accept' }, tag: 'button' } })
  expect(captured.updated).toHaveLength(1)
  expect(JSON.stringify(captured.updated[0][1])).toContain('审批请求无效')
  await bridge.stop()
})

test('startFeishuBridge：非配置审批人点卡 → 拒绝回执不落库', async () => {
  const captured: Captured = { sent: [], updated: [] }
  const itemId = seedItem('仅审批人可操作')
  const bridge = await withBridge(captured)
  await captured.cardHandler!({
    messageId: 'om_x',
    operator: { openId: 'ou_someone_else' },
    action: { value: { itemId, decision: 'accept' }, tag: 'button' },
  })
  expect(getActionItem(db, itemId)?.status).toBe('suggested')
  const reply = JSON.stringify(captured.updated[0][1])
  expect(reply).toContain('非审批人')
  await bridge.stop()
})

test('startFeishuBridge：落库异常（db 已关闭）→ 不冒泡，卡片收到失败回执', async () => {
  const captured: Captured = { sent: [], updated: [] }
  const itemId = seedItem('落库失败场景')
  const bridge = await withBridge(captured)
  closeBoardDb(db) // 制造写库异常
  await captured.cardHandler!({
    messageId: 'om_y',
    operator: { openId: 'ou_approver' },
    action: { value: { itemId, decision: 'accept' }, tag: 'button' },
  })
  expect(captured.updated).toHaveLength(1)
  expect(JSON.stringify(captured.updated[0][1])).toContain('落库失败')
  await bridge.stop()
})
