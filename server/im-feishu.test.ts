import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feishuApprovalCard, feishuResultCard, startFeishuBridge, type CardActionLike, type FeishuChannelLike } from './im-feishu'
import { readActionStore } from './actions'
import type { ApprovalCard } from './im'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-imfeishu-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** dataDir 内放指定期次的样本 CSV（桥接回调按「目录最新期次」校验卡片时效） */
function makeDataDir(period: string): string {
  const d = mkdtempSync(join(tmpdir(), `dp-imfeishu-data-${period.replace(/-/g, '')}-`))
  cpSync(join(__dirname, 'report/testdata', 'sample.csv'), join(d, `会员周报-${period}.csv`))
  return d
}

const card: ApprovalCard = {
  conclusionId: 'c-divergence',
  severity: 'high',
  title: '会员零售额同比 +8.8%，与大盘零售额 -5.9% 背离',
  summary: '会员零售额逆势增长，与大盘方向相反，需确认增长质量。',
  window: '09-12 ~ 09-25',
  period: '2026-09-26',
  attribution: [
    { dimension: '加盟·A品牌-西南加盟', contribution: 42.1, delta: '+38%' },
    { dimension: '直营·A品牌-华东直营', contribution: -18.6, delta: '-12%' },
  ],
  actions: [{ actionId: 'a-divergence-1', text: '核查会员逆势增长的结构质量', impact: '明确资源加减方向' }],
}

test('feishuApprovalCard：schema 携带标题/依据/归因/按钮，value 编码 actionId+decision', () => {
  const json = feishuApprovalCard(card) as {
    header: { title: { content: string }; template: string }
    elements: Array<Record<string, unknown> & { tag?: string; actions?: Array<Record<string, unknown>>; text?: { content?: string } }>
  }
  expect(json.header.title.content).toContain('【高】')
  expect(json.header.title.content).toContain('背离')
  const texts = json.elements.map((e) => e.text?.content ?? '').join('\n')
  expect(texts).toContain('逆势增长')
  expect(texts).toContain('加盟·A品牌-西南加盟')
  expect(texts).toContain('2026-09-26')
  const action = json.elements.find((e) => e.tag === 'action')
  expect(action?.actions).toHaveLength(2)
  const values = action!.actions!.map((b) => b.value)
  expect(values).toContainEqual({ conclusionId: 'c-divergence', actionId: 'a-divergence-1', decision: 'accept', period: '2026-09-26' })
  expect(values).toContainEqual({ conclusionId: 'c-divergence', actionId: 'a-divergence-1', decision: 'reject', period: '2026-09-26' })
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

/* ---- 桥接：cardAction → 落库 → updateCard（fake channel，SDK 网络不进单测）---- */

interface SentItem {
  to: string
  input: { text?: string; card?: object }
}

test('startFeishuBridge：sendApproval 发文本+卡片；cardAction 落库留痕并更新卡片；重复回调提示已处理', async () => {
  const actionsFile = join(dir, 'bridge-actions.json')
  rmSync(actionsFile, { force: true })
  const sent: SentItem[] = []
  const updated: Array<[string, object]> = []
  let cardHandler: ((evt: CardActionLike) => void | Promise<void>) | undefined
  const fake: FeishuChannelLike = {
    send: async (to, input) => {
      sent.push({ to, input })
      return { messageId: `om_${sent.length}` }
    },
    updateCard: async (messageId, card) => {
      updated.push([messageId, card])
    },
    on: (name, handler) => {
      if (name === 'cardAction') cardHandler = handler
      return () => {}
    },
    disconnect: async () => {},
  }

  const bridge = await startFeishuBridge({
    config: { platform: 'feishu', appId: 'cli_x', appSecret: 's', approverUserId: 'ou_approver', approverName: '黄博' },
    actionsFile,
    dataDir: makeDataDir('2026-09-26'),
    channelFactory: async () => fake,
  })

  await bridge.sendApproval('【决策看板】周报摘要', [card])
  expect(sent).toHaveLength(2) // 1 条文本摘要 + 1 张卡片
  expect(sent[0].to).toBe('ou_approver')
  expect(sent[0].input.text).toContain('周报摘要')
  expect(sent[1].input.card).toBeDefined()

  const evt = {
    messageId: 'om_2',
    operator: { openId: 'ou_approver' },
    action: { value: { conclusionId: 'c-divergence', actionId: 'a-divergence-1', decision: 'accept', period: '2026-09-26' }, tag: 'button' },
  }
  await cardHandler!(evt)
  const store = readActionStore(actionsFile)
  expect(store['a-divergence-1']).toMatchObject({ status: 'accepted', decidedBy: '黄博', decidedVia: 'card' })
  expect(updated).toHaveLength(1)
  expect(updated[0][0]).toBe('om_2')
  const replyText = JSON.stringify(updated[0][1])
  expect(replyText).toContain('已采纳')
  expect(replyText).toContain('黄博')

  // 重复回调：store 不变，卡片更新为「已处理」提示（对平台重试幂等）
  await cardHandler!(evt)
  expect(readActionStore(actionsFile)['a-divergence-1'].updatedAt).toBe(store['a-divergence-1'].updatedAt)
  expect(updated).toHaveLength(2)
  expect(JSON.stringify(updated[1][1])).toContain('已处理')

  await bridge.stop()
})

test('startFeishuBridge：非法载荷回调不落库', async () => {
  const actionsFile = join(dir, 'bridge-bad-actions.json')
  rmSync(actionsFile, { force: true })
  let cardHandler: ((evt: CardActionLike) => void | Promise<void>) | undefined
  const fake: FeishuChannelLike = {
    send: async () => ({ messageId: 'om_1' }),
    updateCard: async () => {},
    on: (name, handler) => {
      if (name === 'cardAction') cardHandler = handler
      return () => {}
    },
    disconnect: async () => {},
  }
  const bridge = await startFeishuBridge({
    config: { platform: 'feishu', appId: 'cli_x', appSecret: 's', approverUserId: 'ou_a', approverName: '黄博' },
    actionsFile,
    dataDir: makeDataDir('2026-09-26'),
    channelFactory: async () => fake,
  })
  await cardHandler!({ messageId: 'om_1', operator: { openId: 'ou_a' }, action: { value: { decision: 'accept' }, tag: 'button' } })
  expect(readActionStore(actionsFile)).toEqual({})
  await bridge.stop()
})

test('startFeishuBridge：旧期次卡片（目录已有更新期次）不落库，卡片更新为过期提示', async () => {
  const actionsFile = join(dir, 'bridge-stale-actions.json')
  rmSync(actionsFile, { force: true })
  const updated: Array<[string, object]> = []
  let cardHandler: ((evt: CardActionLike) => void | Promise<void>) | undefined
  const fake: FeishuChannelLike = {
    send: async () => ({ messageId: 'om_1' }),
    updateCard: async (messageId, card) => {
      updated.push([messageId, card])
    },
    on: (name, handler) => {
      if (name === 'cardAction') cardHandler = handler
      return () => {}
    },
    disconnect: async () => {},
  }
  const bridge = await startFeishuBridge({
    config: { platform: 'feishu', appId: 'cli_x', appSecret: 's', approverUserId: 'ou_a', approverName: '黄博' },
    actionsFile,
    dataDir: makeDataDir('2026-10-03'), // 目录已是更新期次
    channelFactory: async () => fake,
  })
  await cardHandler!({
    messageId: 'om_stale',
    operator: { openId: 'ou_a' },
    action: { value: { conclusionId: 'c-divergence', actionId: 'a-divergence-1', decision: 'accept', period: '2026-09-26' }, tag: 'button' },
  })
  expect(readActionStore(actionsFile)).toEqual({})
  expect(updated).toHaveLength(1)
  expect(JSON.stringify(updated[0][1])).toContain('已过期')
  await bridge.stop()
})

/* ---- REVIEW cycle 1：身份校验与落库异常 ---- */

function makeFakeChannel(captured: {
  updated: Array<[string, object]>
  cardHandler?: (evt: CardActionLike) => void | Promise<void>
}): FeishuChannelLike {
  return {
    send: async () => ({ messageId: 'om_1' }),
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

test('startFeishuBridge：非配置审批人点卡 → 拒绝回执不落库（MINOR-1）', async () => {
  const actionsFile = join(dir, 'bridge-who-actions.json')
  rmSync(actionsFile, { force: true })
  const captured: { updated: Array<[string, object]>; cardHandler?: (evt: CardActionLike) => void | Promise<void> } = { updated: [] }
  const bridge = await startFeishuBridge({
    config: { platform: 'feishu', appId: 'cli_x', appSecret: 's', approverUserId: 'ou_approver', approverName: '黄博' },
    actionsFile,
    dataDir: makeDataDir('2026-09-26'),
    channelFactory: async () => makeFakeChannel(captured),
  })
  await captured.cardHandler!({
    messageId: 'om_x',
    operator: { openId: 'ou_someone_else' },
    action: { value: { conclusionId: 'c-divergence', actionId: 'a-divergence-1', decision: 'accept', period: '2026-09-26' }, tag: 'button' },
  })
  expect(readActionStore(actionsFile)).toEqual({})
  expect(captured.updated).toHaveLength(1)
  const reply = JSON.stringify(captured.updated[0][1])
  expect(reply).toContain('非审批人')
  await bridge.stop()
})

test('startFeishuBridge：落库写入异常 → 不冒泡，卡片收到失败回执（MINOR-3）', async () => {
  const notWritable = join(dir, 'bridge-notwritable') // 目录当 actionsFile：writeActionStore rename 失败
  rmSync(notWritable, { recursive: true, force: true })
  mkdirSync(notWritable)
  const captured: { updated: Array<[string, object]>; cardHandler?: (evt: CardActionLike) => void | Promise<void> } = { updated: [] }
  const bridge = await startFeishuBridge({
    config: { platform: 'feishu', appId: 'cli_x', appSecret: 's', approverUserId: 'ou_a', approverName: '黄博' },
    actionsFile: notWritable,
    dataDir: makeDataDir('2026-09-26'),
    channelFactory: async () => makeFakeChannel(captured),
  })
  await captured.cardHandler!({
    messageId: 'om_y',
    operator: { openId: 'ou_a' },
    action: { value: { conclusionId: 'c-divergence', actionId: 'a-divergence-1', decision: 'accept', period: '2026-09-26' }, tag: 'button' },
  })
  expect(captured.updated).toHaveLength(1)
  expect(JSON.stringify(captured.updated[0][1])).toContain('落库失败')
  await bridge.stop()
  rmSync(notWritable, { recursive: true, force: true })
})
