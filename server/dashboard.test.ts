import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { buildDashboardData } from './dashboard'

const FIXTURE_DIR = join(tmpdir(), 'dp-fixtures')

beforeAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  // 真实样本复制为带日期文件名（发现逻辑按文件名日期取最新）
  cpSync(join(__dirname, 'report/testdata', 'sample.csv'), join(FIXTURE_DIR, '会员周报-2026-09-26.csv'))
})

afterAll(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }))

test('真实数据目录：返回计算结果（isDemo=false，period 来自文件名）', () => {
  const data = buildDashboardData(FIXTURE_DIR)
  expect(data.isDemo).toBe(false)
  expect(data.period).toBe('2026-09-26')
  expect(data.title).toBe('决策看板')
  expect(data.conclusions.length).toBeGreaterThan(0)
  expect(data.conclusions[0].severity).toBe('high')
  expect(data.conclusions[0].title).toContain('背离')
  expect(data.metrics).toHaveLength(6)
  expect(data.series).toEqual([])
})

test('多期文件取最新：按文件名日期排序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-multi-'))
  try {
    cpSync(join(FIXTURE_DIR, '会员周报-2026-09-26.csv'), join(dir, '会员周报-2026-09-19.csv'))
    cpSync(join(FIXTURE_DIR, '会员周报-2026-09-26.csv'), join(dir, '会员周报-2026-09-26.csv'))
    const data = buildDashboardData(dir)
    expect(data.period).toBe('2026-09-26')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空目录：回退演示数据并置 isDemo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-empty-'))
  try {
    const data = buildDashboardData(dir)
    expect(data.isDemo).toBe(true)
    expect(data.conclusions).toHaveLength(4)
    expect(data.series.length).toBeGreaterThan(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('损坏 CSV：显式回退演示数据（isDemo），不让接口崩溃', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-bad-'))
  try {
    writeFileSync(join(dir, '会员周报-2026-09-26.csv'), '没有表头的垃圾内容\n', 'utf-8')
    const data = buildDashboardData(dir)
    expect(data.isDemo).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件名无日期：无法确定期次，显式回退演示数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-nodate-'))
  try {
    cpSync(join(FIXTURE_DIR, '会员周报-2026-09-26.csv'), join(dir, '周报.csv'))
    const data = buildDashboardData(dir)
    expect(data.isDemo).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('引擎（非解析）异常向上抛出，不再吞入演示回退', async () => {
  const engine = await import('./rules/engine')
  const spy = vi.spyOn(engine, 'buildConclusions').mockImplementation(() => {
    throw new Error('engine bug')
  })
  expect(() => buildDashboardData(FIXTURE_DIR)).toThrow('engine bug')
  spy.mockRestore()
})

test('actionReview 装配：注入含已执行行动的存储文件', async () => {
  const actionsFile = join(FIXTURE_DIR, 'actions.tmp.json')
  writeFileSync(actionsFile, JSON.stringify({
    'a-ch-test-1': { status: 'executed', executedNote: '已调', period: '2026-09-19', updatedAt: 't', text: '核查西南加盟', dimension: '加盟·A品牌-西南加盟' },
  }), 'utf-8')
  const data = buildDashboardData(FIXTURE_DIR, { actionsFile })
  expect(data.actionReview).toHaveLength(1)
  expect(data.actionReview![0].thisWeek).toContain('+37.8%')
  rmSync(actionsFile, { force: true })
})

/* ---- M3：多周趋势 ---- */

test('双期历史：series 6 条各 2 点、值=各期合计、按时间升序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-hist2-'))
  try {
    cpSync(join(FIXTURE_DIR, '会员周报-2026-09-26.csv'), join(dir, '会员周报-2026-09-19.csv'))
    cpSync(join(FIXTURE_DIR, '会员周报-2026-09-26.csv'), join(dir, '会员周报-2026-09-26.csv'))
    const data = buildDashboardData(dir)
    expect(data.historyCount).toBe(2)
    expect(data.series).toHaveLength(6)
    const memberSales = data.series.find((s) => s.metricId === 'memberSales')!
    expect(memberSales.points.map((p) => p.date)).toEqual(['2026-09-19', '2026-09-26'])
    expect(memberSales.points[0].value).toBeCloseTo(140868333.02, -1)
    // 结论引用的指标能匹配到序列（趋势折线可用）
    expect(data.conclusions.every((c) => data.series.some((s) => s.metricId === c.metricIds[0]))).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('单期历史：series 空、historyCount=1（降级不变）', () => {
  const data = buildDashboardData(FIXTURE_DIR)
  expect(data.historyCount).toBe(1)
  expect(data.series).toEqual([])
})

test('最新一期损坏时显式回退演示（不用旧数据冒充本期）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-hist-bad-'))
  try {
    cpSync(join(FIXTURE_DIR, '会员周报-2026-09-26.csv'), join(dir, '会员周报-2026-09-19.csv'))
    writeFileSync(join(dir, '会员周报-2026-09-26.csv'), '垃圾内容\n', 'utf-8')
    const data = buildDashboardData(dir)
    expect(data.isDemo).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('较旧文件损坏但最新健康：跳过旧文件，正常出数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-hist-oldbad-'))
  try {
    writeFileSync(join(dir, '会员周报-2026-09-12.csv'), '垃圾\n', 'utf-8')
    cpSync(join(FIXTURE_DIR, '会员周报-2026-09-26.csv'), join(dir, '会员周报-2026-09-26.csv'))
    const data = buildDashboardData(dir)
    expect(data.isDemo).toBe(false)
    expect(data.historyCount).toBe(1)
    expect(data.period).toBe('2026-09-26')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同日期多份 CSV：历史去重（首个生效，不产生重复期次点）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-dup-date-'))
  try {
    cpSync(join(FIXTURE_DIR, '会员周报-2026-09-26.csv'), join(dir, '会员周报A-2026-09-26.csv'))
    cpSync(join(FIXTURE_DIR, '会员周报-2026-09-26.csv'), join(dir, '会员周报B-2026-09-26.csv'))
    const data = buildDashboardData(dir)
    expect(data.historyCount).toBe(1)
    expect(data.series).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
