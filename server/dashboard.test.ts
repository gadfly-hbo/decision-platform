import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
