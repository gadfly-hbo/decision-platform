import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readActionStore, writeActionStore, updateActionRecord, ACTION_STATUSES } from './actions'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-actions-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('store 文件不存在 → 空 store；写入后可读回', () => {
  const file = join(dir, 'actions.json')
  expect(readActionStore(file)).toEqual({})
  writeActionStore(file, { 'c-divergence': { status: 'accepted', period: '2026-09-26', updatedAt: 't1' } })
  expect(readActionStore(file)['c-divergence'].status).toBe('accepted')
})

test('损坏的 store 文件 → 空 store（不抛）', () => {
  const file = join(dir, 'broken.json')
  writeFileSync(file, '{not json', 'utf-8')
  expect(readActionStore(file)).toEqual({})
})

test('updateActionRecord：合法更新写入四态之一并带时间戳与期次', () => {
  const store = readActionStore(join(dir, 'actions.json'))
  const next = updateActionRecord(store, 'c-ch-x', { status: 'executed', executedNote: '预算已调' }, '2026-09-26', '2026-10-03T09:00:00Z')
  expect(next['c-ch-x']).toEqual({ status: 'executed', executedNote: '预算已调', period: '2026-09-26', updatedAt: '2026-10-03T09:00:00Z' })
  expect(ACTION_STATUSES).toContain('executed')
})

test('updateActionRecord：非法 status 抛错；备注超长抛错；period 只在首次记录', () => {
  const store: ReturnType<typeof readActionStore> = {}
  expect(() => updateActionRecord(store, 'a', { status: 'done' as never }, 'p', 't')).toThrow(/status/)
  expect(() => updateActionRecord(store, 'a', { status: 'accepted', executedNote: 'x'.repeat(501) }, 'p', 't')).toThrow(/备注/)
  const first = updateActionRecord(store, 'a', { status: 'accepted' }, '2026-09-26', 't')
  const second = updateActionRecord(first, 'a', { status: 'executed' }, '2026-10-03', 't2')
  expect(second['a'].period).toBe('2026-09-26')
})

test('PUT 记录行动文本与维度（首次记录后不变），供跨周对照展示', () => {
  const store: ReturnType<typeof readActionStore> = {}
  const first = updateActionRecord(store, 'a-x-1', { status: 'accepted', text: '核查增长驱动', dimension: '加盟·A品牌-西南加盟' }, '2026-09-26', 't')
  expect(first['a-x-1']).toMatchObject({ text: '核查增长驱动', dimension: '加盟·A品牌-西南加盟' })
  const second = updateActionRecord(first, 'a-x-1', { status: 'executed' }, '2026-10-03', 't2')
  expect(second['a-x-1'].text).toBe('核查增长驱动')
  expect(second['a-x-1'].dimension).toBe('加盟·A品牌-西南加盟')
})

test('executedNote 非字符串抛错（类型校验）', () => {
  const store: ReturnType<typeof readActionStore> = {}
  expect(() => updateActionRecord(store, 'a', { status: 'executed', executedNote: 123 as never }, 'p', 't')).toThrow(/备注/)
})
