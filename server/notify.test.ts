import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readNotifyConfig,
  readNotifyState,
  writeNotifyState,
  isSlugPushed,
  markSlugPushed,
  projectPushKey,
  latestPushedSlugOfProject,
  buildWeeklyDigest,
  buildNotifyPayload,
} from './notify'
import type { BoardView, ReportRecord } from '../src/data/types'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-notify-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const now = Date.now()
const iso = (offsetDays: number) => new Date(now - offsetDays * 24 * 60 * 60 * 1000).toISOString()

function report(over: Partial<ReportRecord>): ReportRecord {
  return {
    id: 1,
    projectId: 'p1',
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
  project: { id: 'p1', title: '会员运营', purpose: '' },
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

test('状态读写：pushedSlugs 集合；旧 lastPushedPeriod 单值并入集合（G8 平移兼容）', () => {
  const f = join(dir, 'state.json')
  writeNotifyState(f, { pushedSlugs: ['p1:a'] })
  expect(readNotifyState(f)).toEqual({ pushedSlugs: ['p1:a'] })
  expect(isSlugPushed(readNotifyState(f), 'p1:a')).toBe(true)
  expect(isSlugPushed(readNotifyState(f), 'p2:a')).toBe(false) // 同 slug 跨项目互不影响

  const legacy = join(dir, 'state-legacy.json')
  writeFileSync(legacy, JSON.stringify({ lastPushedPeriod: '旧周报-2026-09-26' }), 'utf-8')
  expect(readNotifyState(legacy)).toEqual({ pushedSlugs: ['旧周报-2026-09-26'] })

  const mixed = join(dir, 'state-mixed.json')
  writeFileSync(mixed, JSON.stringify({ pushedSlugs: ['p1:a', 'p1:b'], lastPushedPeriod: 'p2:c' }), 'utf-8')
  const state = readNotifyState(mixed)
  expect(isSlugPushed(state, 'p2:c')).toBe(true)

  markSlugPushed(mixed, 'p1:d')
  expect(readNotifyState(mixed).pushedSlugs).toEqual(['p1:a', 'p1:b', 'p2:c', 'p1:d'])
  markSlugPushed(mixed, 'p1:d') // 幂等：重复标记不重复追加
  expect(readNotifyState(mixed).pushedSlugs).toEqual(['p1:a', 'p1:b', 'p2:c', 'p1:d'])
})

test('项目幂等键与项目最近推送：projectId:slug 复合键；latestPushedSlugOfProject 取本项目最新 slug 段', () => {
  expect(projectPushKey('p1', '周报')).toBe('p1:周报')

  const f = join(dir, 'state-project.json')
  writeNotifyState(f, { pushedSlugs: [] })
  markSlugPushed(f, projectPushKey('p1', 'a-周报'))
  markSlugPushed(f, projectPushKey('p2', 'b-周报'))
  markSlugPushed(f, projectPushKey('p1', 'c-周报'))
  const state = readNotifyState(f)
  expect(latestPushedSlugOfProject(state, 'p1')).toBe('c-周报') // 项目内最新（跨项目穿插也正确）
  expect(latestPushedSlugOfProject(state, 'p2')).toBe('b-周报')
  expect(latestPushedSlugOfProject(state, 'p3')).toBeUndefined() // 无推送记录
})
