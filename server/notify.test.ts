import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
