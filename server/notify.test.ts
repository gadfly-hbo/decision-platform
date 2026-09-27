import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import {
  readNotifyConfig,
  readNotifyState,
  writeNotifyState,
  buildWeeklyDigest,
  buildNotifyPayload,
  maybePushNewPeriod,
  latestPeriodInDir,
  scanAndPush,
  startPushScheduler,
} from './notify'
import type { DashboardData } from '../src/data/types'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-notify-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => vi.unstubAllGlobals())

const data = {
  period: '2026-09-26',
  isDemo: false,
  conclusions: [
    { id: 'c1', severity: 'high', title: '会员零售额同比 +8.8%，与大盘零售额 -5.9% 背离', actions: [{ id: 'a1' }] },
    { id: 'c2', severity: 'medium', title: '渠道异动 X', actions: [] },
  ],
} as unknown as DashboardData

test('配置读取：缺失/损坏 → null（未配置）', () => {
  expect(readNotifyConfig(join(dir, 'none.json'))).toBeNull()
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{oops', 'utf-8')
  expect(readNotifyConfig(bad)).toBeNull()
  const good = join(dir, 'good.json')
  writeFileSync(good, JSON.stringify({ platform: 'feishu', url: 'https://x' }), 'utf-8')
  expect(readNotifyConfig(good)).toEqual({ platform: 'feishu', url: 'https://x' })
})

test('摘要：期次 + 结论标题 + 行动计数，数字与看板同源', () => {
  const digest = buildWeeklyDigest(data, {})
  expect(digest).toContain('2026-09-26')
  expect(digest).toContain('背离')
  expect(digest).toContain('本周结论 2 条（高优先级 1 条待拍板）')
  const withStore = buildWeeklyDigest(data, { a1: { status: 'executed', period: 'p', updatedAt: 't' } })
  expect(withStore).toContain('已执行 1')
})

test('三平台与通用 payload 形状', () => {
  expect(buildNotifyPayload('feishu', 't')).toEqual({ msg_type: 'text', content: { text: 't' } })
  expect(buildNotifyPayload('dingtalk', 't')).toEqual({ msgtype: 'text', text: { content: 't' } })
  expect(buildNotifyPayload('wecom', 't')).toEqual({ msgtype: 'text', text: { content: 't' } })
  expect(buildNotifyPayload('generic', 't')).toEqual({ text: 't' })
})

test('幂等推送：新期次推一次并落状态；同期次不重推；未配置跳过', async () => {
  const stateFile = join(dir, 'state.json')
  const config = { platform: 'feishu' as const, url: 'https://hook.example/x' }
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true } as Response))
  vi.stubGlobal('fetch', fetchMock)

  const noCfg = await maybePushNewPeriod({ config: null, stateFile, period: '2026-09-26', digest: 'd' })
  expect(noCfg).toEqual({ pushed: false, reason: 'not-configured' })
  expect(fetchMock).not.toHaveBeenCalled()

  const first = await maybePushNewPeriod({ config, stateFile, period: '2026-09-26', digest: '本周摘要' })
  expect(first.pushed).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('https://hook.example/x')
  expect((init as RequestInit).body).toContain('本周摘要')
  expect(readNotifyState(stateFile).lastPushedPeriod).toBe('2026-09-26')

  const again = await maybePushNewPeriod({ config, stateFile, period: '2026-09-26', digest: 'd' })
  expect(again.pushed).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('发送失败：不更新状态并上抛', async () => {
  const stateFile = join(dir, 'state2.json')
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: false, status: 500 } as Response))
  vi.stubGlobal('fetch', fetchMock)
  await expect(
    maybePushNewPeriod({ config: { platform: 'generic' as const, url: 'https://x' }, stateFile, period: '2026-10-03', digest: 'd' }),
  ).rejects.toThrow(/500/)
  expect(readNotifyState(stateFile).lastPushedPeriod).toBe('')
})

test('writeNotifyState 可写回', () => {
  const f = join(dir, 'state3.json')
  writeNotifyState(f, { lastPushedPeriod: '2026-10-03' })
  expect(readNotifyState(f).lastPushedPeriod).toBe('2026-10-03')
})

/* ---- M4a：定时扫描推送（红队 KA1：推送不依赖打开看板）---- */

test('latestPeriodInDir：取目录最新 CSV 期次；空目录/目录缺失 → null', () => {
  const d = mkdtempSync(join(tmpdir(), 'dp-scan-'))
  try {
    expect(latestPeriodInDir(d)).toBeNull()
    expect(latestPeriodInDir(join(d, 'no-such-dir'))).toBeNull()
    cpSync(join(__dirname, 'report/testdata', 'sample.csv'), join(d, '会员周报-2026-09-19.csv'))
    expect(latestPeriodInDir(d)).toBe('2026-09-19')
    cpSync(join(__dirname, 'report/testdata', 'sample.csv'), join(d, '会员周报4213-20260926.csv'))
    expect(latestPeriodInDir(d)).toBe('2026-09-26')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('scanAndPush：新期次无需打开看板即推送（幂等）；未配置跳过；空目录不推', async () => {
  const d = mkdtempSync(join(tmpdir(), 'dp-scanpush-'))
  try {
    cpSync(join(__dirname, 'report/testdata', 'sample.csv'), join(d, '会员周报-2026-09-26.csv'))
    const notifyFile = join(dir, 'scan-notify.json')
    writeFileSync(notifyFile, JSON.stringify({ platform: 'feishu', url: 'https://hook.example/s' }), 'utf-8')
    const stateFile = join(dir, 'scan-state.json')
    const actionsFile = join(dir, 'scan-actions.json')
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({ ok: true } as Response))
    vi.stubGlobal('fetch', fetchMock)

    const noCfg = await scanAndPush({ dataDir: d, actionsFile, notifyFile: join(dir, 'missing.json'), notifyStateFile: stateFile })
    expect(noCfg).toEqual({ pushed: false, reason: 'not-configured' })
    expect(fetchMock).not.toHaveBeenCalled()

    const first = await scanAndPush({ dataDir: d, actionsFile, notifyFile, notifyStateFile: stateFile })
    expect(first.pushed).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = (fetchMock.mock.calls[0][1] as RequestInit).body as string
    expect(body).toContain('2026-09-26')
    expect(body).toContain('背离')
    expect(readNotifyState(stateFile).lastPushedPeriod).toBe('2026-09-26')

    const again = await scanAndPush({ dataDir: d, actionsFile, notifyFile, notifyStateFile: stateFile })
    expect(again.pushed).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const empty = mkdtempSync(join(tmpdir(), 'dp-scanempty-'))
    try {
      const noPeriod = await scanAndPush({ dataDir: empty, actionsFile, notifyFile, notifyStateFile: stateFile })
      expect(noPeriod.pushed).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    rmSync(d, { recursive: true, force: true })
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

/* ---- M4b：IM 通道推送编排（文本+卡片，优先于 webhook）---- */

test('scanAndPush 优先 IM 通道（文本+高优卡片）且不触发 webhook；失败不落状态（整包重试语义）', async () => {
  const d = mkdtempSync(join(tmpdir(), 'dp-scanim-'))
  try {
    cpSync(join(__dirname, 'report/testdata', 'sample.csv'), join(d, '会员周报-2026-09-26.csv'))
    const notifyFile = join(dir, 'scanim-notify.json')
    writeFileSync(notifyFile, JSON.stringify({ platform: 'feishu', url: 'https://hook.example/w' }), 'utf-8')
    const stateFile = join(dir, 'scanim-state.json')
    const actionsFile = join(dir, 'scanim-actions.json')
    const fetchMock = vi.fn(async () => ({ ok: true } as Response))
    vi.stubGlobal('fetch', fetchMock)

    const sent: Array<{ digest: string; cardCount: number }> = []
    const okChannel = {
      sendApproval: vi.fn(async (digest: string, cards: unknown[]) => {
        sent.push({ digest, cardCount: cards.length })
      }),
    }
    const first = await scanAndPush({ dataDir: d, actionsFile, notifyFile, notifyStateFile: stateFile, imChannel: okChannel })
    expect(first.pushed).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled() // 有 IM 通道时不走群机器人
    expect(sent).toHaveLength(1)
    expect(sent[0].digest).toContain('2026-09-26')
    expect(sent[0].cardCount).toBeGreaterThanOrEqual(1) // sample.csv 高优结论成卡
    expect(readNotifyState(stateFile).lastPushedPeriod).toBe('2026-09-26')
    expect(okChannel.sendApproval).toHaveBeenCalledTimes(1)

    // 幂等：同期次不再推
    const again = await scanAndPush({ dataDir: d, actionsFile, notifyFile, notifyStateFile: stateFile, imChannel: okChannel })
    expect(again.pushed).toBe(false)
    expect(okChannel.sendApproval).toHaveBeenCalledTimes(1)

    // 失败：不上状态（下轮整包重试），异常上抛由调度器记日志
    const stateFile2 = join(dir, 'scanim-state2.json')
    const failChannel = {
      sendApproval: vi.fn(async () => {
        throw new Error('飞书发送失败')
      }),
    }
    await expect(
      scanAndPush({ dataDir: d, actionsFile, notifyFile, notifyStateFile: stateFile2, imChannel: failChannel }),
    ).rejects.toThrow(/飞书发送失败/)
    expect(readNotifyState(stateFile2).lastPushedPeriod).toBe('')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
