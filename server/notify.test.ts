import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import {
  readNotifyConfig,
  readNotifyState,
  writeNotifyState,
  isSlugPushed,
  markSlugPushed,
  latestPushedSlug,
  buildWeeklyDigest,
  buildNotifyPayload,
  runPushFunnel,
  startPushScheduler,
  type ImPushChannel,
} from './notify'
import { createReportPipeline } from './reports'
import type { ActionItemDraft } from './agent/types'
import type { ExtractionRunner } from './agent/extract'
import type { ApprovalCard } from './im'
import type { BoardView, ReportRecord } from '../src/data/types'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-notify-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => vi.unstubAllGlobals())

const now = Date.now()
const iso = (offsetDays: number) => new Date(now - offsetDays * 24 * 60 * 60 * 1000).toISOString()

function report(over: Partial<ReportRecord>): ReportRecord {
  return {
    id: 1,
    slug: '会员周报-2026-10-10',
    filename: '会员周报-2026-10-10.md',
    status: 'done',
    error: null,
    importedAt: iso(1),
    updatedAt: iso(1),
    ...over,
  }
}

const view: BoardView = {
  title: '决策看板',
  lede: 'x',
  reports: [report({ id: 1 }), report({ id: 2, slug: '月度经营复盘', filename: '月度经营复盘.md', status: 'pending', importedAt: iso(30), updatedAt: iso(30) })],
  actionItems: [],
  stats: { suggested: 3, adopted: 2, dismissed: 1, manual: 1 },
  notify: { configured: true },
  modelChain: { available: true, providers: [] },
  isDemo: false,
}

test('配置读取：缺失/损坏 → null（未配置）', () => {
  expect(readNotifyConfig(join(dir, 'none.json'))).toBeNull()
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{oops', 'utf-8')
  expect(readNotifyConfig(bad)).toBeNull()
  const good = join(dir, 'good.json')
  writeFileSync(good, JSON.stringify({ platform: 'feishu', url: 'https://x' }), 'utf-8')
  expect(readNotifyConfig(good)).toEqual({ platform: 'feishu', url: 'https://x' })
})

test('摘要：本周报告 N 份（7 天滚动窗）+ 建议/已采纳/已驳回/人工补充计数，与看板统计同源', () => {
  const digest = buildWeeklyDigest(view)
  expect(digest).toContain('本周报告 1 份') // 30 天前导入的月复查不计入本周
  expect(digest).toContain('建议 3 / 已采纳 2 / 已驳回 1 / 人工补充 1')
})

test('三平台与通用 payload 形状', () => {
  expect(buildNotifyPayload('feishu', 't')).toEqual({ msg_type: 'text', content: { text: 't' } })
  expect(buildNotifyPayload('dingtalk', 't')).toEqual({ msgtype: 'text', text: { content: 't' } })
  expect(buildNotifyPayload('wecom', 't')).toEqual({ msgtype: 'text', text: { content: 't' } })
  expect(buildNotifyPayload('generic', 't')).toEqual({ text: 't' })
})

/* ---- notify-state：pushedSlugs 集合 + 旧单值兼容 ---- */

test('状态读写：pushedSlugs 集合；旧 lastPushedPeriod 单值并入集合（G8 平移兼容）', () => {
  const f = join(dir, 'state.json')
  writeNotifyState(f, { pushedSlugs: ['a'] })
  expect(readNotifyState(f)).toEqual({ pushedSlugs: ['a'] })
  expect(isSlugPushed(readNotifyState(f), 'a')).toBe(true)
  expect(isSlugPushed(readNotifyState(f), 'b')).toBe(false)

  const legacy = join(dir, 'state-legacy.json')
  writeFileSync(legacy, JSON.stringify({ lastPushedPeriod: '旧周报-2026-09-26' }), 'utf-8')
  expect(readNotifyState(legacy)).toEqual({ pushedSlugs: ['旧周报-2026-09-26'] })

  const mixed = join(dir, 'state-mixed.json')
  writeFileSync(mixed, JSON.stringify({ pushedSlugs: ['a', 'b'], lastPushedPeriod: 'c' }), 'utf-8')
  const state = readNotifyState(mixed)
  expect(isSlugPushed(state, 'c')).toBe(true)
  expect(latestPushedSlug(state)).toBe('c') // BoardView.lastPushedReport 数据源

  markSlugPushed(mixed, 'd')
  expect(readNotifyState(mixed).pushedSlugs).toEqual(['a', 'b', 'c', 'd'])
  markSlugPushed(mixed, 'd') // 幂等：重复标记不重复追加
  expect(readNotifyState(mixed).pushedSlugs).toEqual(['a', 'b', 'c', 'd'])
})

/* ---- 推送漏斗（假 runner + 假 channel + 临时目录/库）---- */

const DRAFT_HIGH: ActionItemDraft = {
  title: '对沉睡会员发放阶梯券',
  rationale: '复购率下滑',
  expectedImpact: '复购率 +2pp',
  priority: 'high',
  effort: 'medium',
  confidence: 0.92,
  evidence: { facts: [{ text: '复购率下滑', quote: '会员复购率由 12% 降至 9%' }], level: '数据支撑', reasoning: 'r' },
}

const DRAFT_LOW: ActionItemDraft = {
  title: '更新门店物料',
  rationale: '门店物料陈旧',
  expectedImpact: '形象提升',
  priority: 'low',
  effort: 'low',
  confidence: 0.3,
  evidence: { facts: [], level: '经验假设', reasoning: 'r' },
}

interface FunnelFixture {
  dataDir: string
  stateFile: string
  notifyFile: string
  dbPath: string
  close(): void
}

/** 独立临时工作区：raw/ + board.db + notify 配置与状态（用例间完全隔离） */
function makeFixture(configured = true): FunnelFixture {
  const work = mkdtempSync(join(tmpdir(), 'dp-funnel-'))
  const dataDir = join(work, 'raw')
  mkdirSync(dataDir, { recursive: true })
  const stateFile = join(work, 'notify-state.json')
  const notifyFile = join(work, 'notify.json')
  if (configured) {
    writeFileSync(notifyFile, JSON.stringify({ platform: 'feishu', url: 'https://hook.example/f' }), 'utf-8')
  }
  return { dataDir, stateFile, notifyFile, dbPath: join(work, 'board.db'), close: () => rmSync(work, { recursive: true, force: true }) }
}

function fakeRunner(drafts: ActionItemDraft[] = [DRAFT_HIGH]): ExtractionRunner & { inputs: unknown[][] } {
  const inputs: unknown[][] = []
  return {
    inputs,
    async runExtraction(input) {
      inputs.push([input])
      return drafts
    },
    async runExtractionRaw() {
      throw new Error('not used')
    },
  }
}

function fakeChannel(): ImPushChannel & { rounds: Array<{ digest: string; cards: ApprovalCard[] }> } {
  const rounds: Array<{ digest: string; cards: ApprovalCard[] }> = []
  return {
    rounds,
    async sendApproval(digest, cards) {
      rounds.push({ digest, cards })
    },
  }
}

test('漏斗：新报告自动抽取 + 推送一轮（文本+高优卡片）；同 slug 幂等不重推', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.dataDir, 'r1.md'), '# 报告一\n会员复购率由 12% 降至 9%。')
    const pipeline = createReportPipeline(fx.dataDir, fx.dbPath)
    const runner = fakeRunner()
    const channel = fakeChannel()

    const first = await runPushFunnel({ pipeline, agentRunner: runner, notifyFile: fx.notifyFile, notifyStateFile: fx.stateFile, imChannel: channel })
    expect(first.extracted).toMatchObject([{ slug: 'r1', status: 'done', inserted: 1 }])
    expect(first.pushedSlugs).toEqual(['r1'])
    expect(channel.rounds).toHaveLength(1)
    expect(channel.rounds[0].digest).toContain('建议 1')
    expect(channel.rounds[0].cards).toHaveLength(1) // high 建议成卡
    expect(channel.rounds[0].cards[0]).toMatchObject({ itemId: expect.any(String), title: '对沉睡会员发放阶梯券' })
    expect(isSlugPushed(readNotifyState(fx.stateFile), 'r1')).toBe(true)

    // 第二轮：无新报告、r1 已推 → 零动作（幂等）
    const again = await runPushFunnel({ pipeline, agentRunner: runner, notifyFile: fx.notifyFile, notifyStateFile: fx.stateFile, imChannel: channel })
    expect(again.extracted).toEqual([])
    expect(again.pushedSlugs).toEqual([])
    expect(channel.rounds).toHaveLength(1)
    pipeline.close()
  } finally {
    fx.close()
  }
})

test('漏斗：抽取失败不推送（failed 保留可重试）；恢复后下轮抽取并推送', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.dataDir, 'r1.md'), '报告')
    const pipeline = createReportPipeline(fx.dataDir, fx.dbPath)
    const channel = fakeChannel()
    let fail = true
    const runner: ExtractionRunner = {
      async runExtraction() {
        if (fail) throw new Error('模型超时')
        return [DRAFT_HIGH]
      },
      async runExtractionRaw() {
        throw new Error('not used')
      },
    }

    const first = await runPushFunnel({ pipeline, agentRunner: runner, notifyFile: fx.notifyFile, notifyStateFile: fx.stateFile, imChannel: channel })
    expect(first.extracted[0]).toMatchObject({ slug: 'r1', status: 'failed', error: '模型超时' })
    expect(first.pushedSlugs).toEqual([])
    expect(channel.rounds).toHaveLength(0)
    expect(readNotifyState(fx.stateFile).pushedSlugs).toEqual([])

    fail = false
    const second = await runPushFunnel({ pipeline, agentRunner: runner, notifyFile: fx.notifyFile, notifyStateFile: fx.stateFile, imChannel: channel })
    expect(second.extracted[0]).toMatchObject({ slug: 'r1', status: 'done' }) // failed 可重试
    expect(second.pushedSlugs).toEqual(['r1'])
    expect(channel.rounds).toHaveLength(1)
    pipeline.close()
  } finally {
    fx.close()
  }
})

test('漏斗：低优建议不占卡片（防审批疲劳）——仅进文本摘要', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.dataDir, 'r1.md'), '报告')
    const pipeline = createReportPipeline(fx.dataDir, fx.dbPath)
    const channel = fakeChannel()
    const first = await runPushFunnel({
      pipeline,
      agentRunner: fakeRunner([DRAFT_LOW, DRAFT_LOW]),
      notifyFile: fx.notifyFile,
      notifyStateFile: fx.stateFile,
      imChannel: channel,
    })
    expect(first.extracted[0]).toMatchObject({ inserted: 2 })
    expect(first.pushedSlugs).toEqual(['r1'])
    expect(channel.rounds).toHaveLength(1)
    expect(channel.rounds[0].cards).toHaveLength(0) // 低优/经验假设 → 只发文本
    expect(channel.rounds[0].digest).toContain('建议 2')
    pipeline.close()
  } finally {
    fx.close()
  }
})

test('漏斗：多报告各自推一轮（修复单值字典序漏推），按导入时间正序', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.dataDir, 'aaa-旧报告.md'), 'A')
    writeFileSync(join(fx.dataDir, 'zzz-新报告.md'), 'B')
    const pipeline = createReportPipeline(fx.dataDir, fx.dbPath)
    const channel = fakeChannel()
    const first = await runPushFunnel({
      pipeline,
      agentRunner: fakeRunner(),
      notifyFile: fx.notifyFile,
      notifyStateFile: fx.stateFile,
      imChannel: channel,
    })
    expect(first.pushedSlugs).toHaveLength(2)
    expect(channel.rounds).toHaveLength(2)
    // 已推集合覆盖全部 slug（不再依赖字典序比较）
    const state = readNotifyState(fx.stateFile)
    expect(isSlugPushed(state, 'aaa-旧报告')).toBe(true)
    expect(isSlugPushed(state, 'zzz-新报告')).toBe(true)
    pipeline.close()
  } finally {
    fx.close()
  }
})

test('漏斗：webhook 降级——无 IM 通道时走群机器人文本摘要（含 IM 通道则不触发 webhook）', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.dataDir, 'r1.md'), '报告')
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({ ok: true } as Response))
    vi.stubGlobal('fetch', fetchMock)
    const pipeline = createReportPipeline(fx.dataDir, fx.dbPath)

    const first = await runPushFunnel({ pipeline, agentRunner: fakeRunner(), notifyFile: fx.notifyFile, notifyStateFile: fx.stateFile })
    expect(first.pushedSlugs).toEqual(['r1'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = (fetchMock.mock.calls[0][1] as RequestInit).body as string
    expect(body).toContain('行动闭环周摘要')
    expect(isSlugPushed(readNotifyState(fx.stateFile), 'r1')).toBe(true)

    // 有 IM 通道时不走 webhook（卡片通道优先）
    const channel = fakeChannel()
    writeFileSync(join(fx.dataDir, 'r2.md'), '报告二')
    await runPushFunnel({ pipeline, agentRunner: fakeRunner(), notifyFile: fx.notifyFile, notifyStateFile: fx.stateFile, imChannel: channel })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(channel.rounds).toHaveLength(1)
    expect(channel.rounds[0].cards).toHaveLength(1)
    pipeline.close()
  } finally {
    fx.close()
  }
})

test('漏斗：无 runner 跳过自动抽取（报告保持 pending）、不推送；未配置通道不推送', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.dataDir, 'r1.md'), '报告')
    const pipeline = createReportPipeline(fx.dataDir, fx.dbPath)
    const channel = fakeChannel()
    const noRunner = await runPushFunnel({ pipeline, agentRunner: null, notifyFile: fx.notifyFile, notifyStateFile: fx.stateFile, imChannel: channel })
    expect(noRunner.reason).toBeUndefined() // 通道已配置，仅无报告可推
    expect(noRunner.extracted).toEqual([])
    expect(noRunner.pushedSlugs).toEqual([])
    expect(channel.rounds).toHaveLength(0)
    expect(pipeline.listReports()[0]).toMatchObject({ status: 'pending' }) // 未被抽取

    const unconfigured = makeFixture(false)
    try {
      const noChannel = await runPushFunnel({ pipeline, agentRunner: null, notifyFile: unconfigured.notifyFile, notifyStateFile: unconfigured.stateFile })
      expect(noChannel.reason).toBe('not-configured')
      expect(noChannel.pushedSlugs).toEqual([])
    } finally {
      unconfigured.close()
    }
    pipeline.close()
  } finally {
    fx.close()
  }
})

test('漏斗：IM 发送失败不上状态（该 slug 下轮整轮重试），异常上抛由调度器记日志', async () => {
  const fx = makeFixture()
  try {
    writeFileSync(join(fx.dataDir, 'r1.md'), '报告')
    const pipeline = createReportPipeline(fx.dataDir, fx.dbPath)
    const failing: ImPushChannel = {
      async sendApproval() {
        throw new Error('飞书发送失败')
      },
    }
    await expect(
      runPushFunnel({ pipeline, agentRunner: fakeRunner(), notifyFile: fx.notifyFile, notifyStateFile: fx.stateFile, imChannel: failing }),
    ).rejects.toThrow(/飞书发送失败/)
    expect(readNotifyState(fx.stateFile).pushedSlugs).toEqual([])
    pipeline.close()
  } finally {
    fx.close()
  }
})

test('startPushScheduler：启动先扫一次、按间隔重复、异常不中断、stop 后不再触发', async () => {
  vi.useFakeTimers()
  try {
    const scan = vi.fn(async () => {
      if (scan.mock.calls.length === 2) throw new Error('boom')
    })
    const stop = startPushScheduler(scan, 60_000, 10)
    await vi.advanceTimersByTimeAsync(10)
    expect(scan).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scan).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scan).toHaveBeenCalledTimes(3) // 第 2 次 boom 被吞，调度继续
    stop()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(scan).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})
