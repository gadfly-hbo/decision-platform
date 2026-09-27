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

test('updateActionRecord：合法更新写入四态之一并带时间戳与期次（PC 决策默认留痕 via=pc）', () => {
  const store = readActionStore(join(dir, 'actions.json'))
  const next = updateActionRecord(store, 'c-ch-x', { status: 'executed', executedNote: '预算已调' }, '2026-09-26', '2026-10-03T09:00:00Z')
  expect(next['c-ch-x']).toEqual({ status: 'executed', executedNote: '预算已调', period: '2026-09-26', updatedAt: '2026-10-03T09:00:00Z', decidedAt: '2026-10-03T09:00:00Z', decidedVia: 'pc' })
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

/* ---- M4a：审批留痕 ---- */

test('卡片决策留痕：decidedBy/decidedVia 落库，decidedAt 取操作时间；后续仅改备注不动留痕', () => {
  const store: ReturnType<typeof readActionStore> = {}
  const first = updateActionRecord(store, 'a-card', { status: 'accepted', decidedBy: '张三', decidedVia: 'card' }, '2026-09-26', '2026-10-03T08:00:00Z')
  expect(first['a-card']).toMatchObject({ decidedBy: '张三', decidedAt: '2026-10-03T08:00:00Z', decidedVia: 'card' })
  const second = updateActionRecord(first, 'a-card', { executedNote: '本周内落地' }, '2026-10-03', '2026-10-05T09:00:00Z')
  expect(second['a-card']).toMatchObject({ decidedBy: '张三', decidedAt: '2026-10-03T08:00:00Z', decidedVia: 'card' })
  expect(second['a-card'].updatedAt).toBe('2026-10-05T09:00:00Z')
})

test('回滚 pending 清空留痕', () => {
  const store: ReturnType<typeof readActionStore> = {}
  const decided = updateActionRecord(store, 'a-r', { status: 'rejected', decidedBy: '李四', decidedVia: 'card' }, 'p', 't1')
  const back = updateActionRecord(decided, 'a-r', { status: 'pending' }, 'p', 't2')
  expect(back['a-r'].decidedBy).toBeUndefined()
  expect(back['a-r'].decidedAt).toBeUndefined()
  expect(back['a-r'].decidedVia).toBeUndefined()
})

test('PC 标记 executed 保留卡片审批留痕（REVIEW cycle 1 MINOR-2：执行≠新审批）', () => {
  const store: ReturnType<typeof readActionStore> = {}
  const cardAccepted = updateActionRecord(store, 'a-exec', { status: 'accepted', decidedBy: '张三', decidedVia: 'card' }, '2026-09-26', '2026-09-27T08:00:00Z')
  const executed = updateActionRecord(cardAccepted, 'a-exec', { status: 'executed', executedNote: '预算已调整' }, '2026-10-03', '2026-10-05T09:00:00Z')
  expect(executed['a-exec']).toMatchObject({
    status: 'executed',
    executedNote: '预算已调整',
    decidedBy: '张三',
    decidedAt: '2026-09-27T08:00:00Z',
    decidedVia: 'card',
  })
  // 无既有留痕时（直接 PC executed）：记执行时刻 via=pc（现状语义不变）
  const fresh = updateActionRecord(store, 'a-fresh', { status: 'executed' }, 'p', '2026-10-05T09:00:00Z')
  expect(fresh['a-fresh']).toMatchObject({ decidedAt: '2026-10-05T09:00:00Z', decidedVia: 'pc' })
  expect(fresh['a-fresh'].decidedBy).toBeUndefined()
})

test('旧记录无留痕字段兼容读取；非法 decidedVia / decidedBy 抛错', () => {
  const legacy: ReturnType<typeof readActionStore> = { 'a-old': { status: 'accepted', period: '2026-09-26', updatedAt: 't0' } }
  const next = updateActionRecord(legacy, 'a-old', { executedNote: '补录说明' }, 'p', 't1')
  expect(next['a-old']).toMatchObject({ status: 'accepted', executedNote: '补录说明' })
  expect(next['a-old'].decidedAt).toBeUndefined()
  const store: ReturnType<typeof readActionStore> = {}
  expect(() => updateActionRecord(store, 'a', { status: 'accepted', decidedVia: 'im' as never }, 'p', 't')).toThrow(/decidedVia/)
  expect(() => updateActionRecord(store, 'a', { status: 'accepted', decidedBy: 42 as never }, 'p', 't')).toThrow(/decidedBy/)
  expect(() => updateActionRecord(store, 'a', { status: 'accepted', decidedBy: 'x'.repeat(101) }, 'p', 't')).toThrow(/decidedBy/)
})
