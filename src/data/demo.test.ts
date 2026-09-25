import { demoData } from './demo'
import type { DerivationKind } from './types'

/** 验收标准（.flow/tasks.md 任务2）的独立断言，不引用实现逻辑。 */
const DERIVATION_ORDER: DerivationKind[] = ['detection', 'attribution', 'rule', 'suggestion']

test('演示数据：4 条结论，严重度覆盖 高/中/中/低 且已排序', () => {
  expect(demoData.conclusions).toHaveLength(4)
  expect(demoData.conclusions.map((c) => c.severity)).toEqual(['high', 'medium', 'medium', 'low'])
})

test('演示数据：每条推导链路含 检测→归因→规则匹配→建议 四步且有序', () => {
  for (const c of demoData.conclusions) {
    expect(c.derivation.map((s) => s.kind)).toEqual(DERIVATION_ORDER)
  }
})

test('演示数据：归因明细按 |贡献| 降序', () => {
  for (const c of demoData.conclusions) {
    const abs = c.breakdown.map((r) => Math.abs(r.contribution))
    expect([...abs].sort((a, b) => b - a)).toEqual(abs)
  }
})

test('演示数据：指标引用与序列全部可解析，序列均为 14 天', () => {
  const metricIds = new Set(demoData.metrics.map((m) => m.id))
  const seriesIds = new Set(demoData.series.map((s) => s.metricId))
  for (const c of demoData.conclusions) {
    for (const id of c.metricIds) {
      expect(metricIds.has(id)).toBe(true)
      expect(seriesIds.has(id)).toBe(true)
    }
  }
  for (const s of demoData.series) {
    expect(s.points).toHaveLength(14)
  }
})

test('演示数据：行动归属正确的结论', () => {
  const conclusionIds = new Set(demoData.conclusions.map((c) => c.id))
  for (const c of demoData.conclusions) {
    for (const a of c.actions) {
      expect(a.conclusionId).toBe(c.id)
      expect(conclusionIds.has(a.conclusionId)).toBe(true)
    }
  }
})

/** 从序列尾部数连续低于基线的天数（独立复算口径，与审查者 node 复算一致） */
function streakBelowFromEnd(values: number[], baseline: number): number {
  let streak = 0
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] < baseline) streak++
    else break
  }
  return streak
}

test('演示数据：叙述数字与序列复算一致（审查 cycle 1 修正的回归）', () => {
  const byId = (id: string) => demoData.conclusions.find((c) => c.id === id)!
  const seriesOf = (id: string) => demoData.series.find((s) => s.metricId === id)!

  // 归因占比：由 breakdown 复算（首位贡献 / |贡献| 合计），与文本解析值一致
  const shareOfTop = (id: string) => {
    const rows = byId(id).breakdown
    const total = rows.reduce((sum, row) => sum + Math.abs(row.contribution), 0)
    return Math.round((Math.abs(rows[0].contribution) / total) * 100)
  }
  expect(byId('c1').derivation[1].text).toContain(`占 ${shareOfTop('c1')}%`)
  expect(byId('c2').derivation[1].text).toContain(`占 ${shareOfTop('c2')}%`)

  // c1「连续 3 日」与止损线复算一致
  expect(streakBelowFromEnd(seriesOf('roi-search-a').points.map((p) => p.value), 1.0)).toBe(3)

  // c3「连续 7 日」与对比基线复算一致
  const cvrBaseline = seriesOf('cvr-overall').baselines[0].value
  expect(streakBelowFromEnd(seriesOf('cvr-overall').points.map((p) => p.value), cvrBaseline)).toBe(7)
  expect(byId('c3').title).toContain('连续 7 日')
  expect(byId('c3').derivation[0].text).toContain('连续 7 日')

  // c4「连续 9 日」与目标线复算一致
  const ctrTarget = seriesOf('ctr-display-c').baselines[0].value
  expect(streakBelowFromEnd(seriesOf('ctr-display-c').points.map((p) => p.value), ctrTarget)).toBe(9)
  expect(byId('c4').title).toContain('连续 9 日')
  expect(byId('c4').derivation[0].text).toContain('连续 9 日')
})

test('演示数据：均值基线与行动影响可由序列复算（审查 cycle 2 修正的回归）', () => {
  const seriesOf = (id: string) => demoData.series.find((s) => s.metricId === id)!
  const byId = (id: string) => demoData.conclusions.find((c) => c.id === id)!
  const meanOfFirst = (id: string, n: number) => {
    const vs = seriesOf(id).points.slice(0, n).map((p) => p.value)
    return Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100
  }

  // 「前 7 日均值」口径 = 窗口前 7 个点的均值；c2 图上 markLine 与叙述同源
  expect(meanOfFirst('roi-feed-b', 7)).toBe(1.48)
  expect(seriesOf('roi-feed-b').baselines[0].value).toBe(1.48)
  expect(meanOfFirst('roi-search-a', 7)).toBe(1.25)
  expect(byId('c1').derivation[0].text).toContain('前 7 日均值 1.25')

  // c2：环比由序列复算（末值 vs 前 7 日均值），与标题解析值一致；归因合计 = 偏离量 2.1 − 1.48 = 0.62
  const c2 = byId('c2')
  const feedValues = seriesOf('roi-feed-b').points.map((p) => p.value)
  const feedMean = feedValues.slice(0, 7).reduce((a, b) => a + b, 0) / 7
  const expectedPct = Math.round(((feedValues[13] - feedMean) / feedMean) * 100)
  expect(c2.title).toContain(`+${expectedPct}%`)
  expect(expectedPct).toBe(42)
  expect(c2.breakdown.reduce((sum, row) => sum + row.contribution, 0)).toBeCloseTo(0.62, 10)

  // c2 行动影响按增量预算 × ROI 复算：+¥600 × 2.1 ≈ ¥1,300（非全额 ¥3,000 × 2.1）
  expect(c2.actions[0].impact).toContain('¥1,300')

  // c3：环比按显示基线复算（0.028 − 0.032）/ 0.032 = −12.5%
  expect(byId('c3').title).toContain(
    `${(((0.028 - 0.032) / 0.032) * 100).toFixed(1)}%`,
  )
})

test('演示数据：四条行动影响的数字可由屏上操作数复算（审查 cycle 3 修正的回归）', () => {
  const byId = (id: string) => demoData.conclusions.find((c) => c.id === id)!

  // 操作数必须在屏上文本中出现（否则影响不可核查）
  expect(byId('c1').derivation[3].text).toContain('¥5,000')
  expect(byId('c2').actions[0].text).toContain('¥3,000 → ¥3,600')
  expect(byId('c3').actions[0].impact).toContain('3.5 万')

  // c4：目标线 1.8% 与序列 baseline 同源
  const target = demoData.series.find((s) => s.metricId === 'ctr-display-c')!.baselines[0]
  expect(byId('c4').actions[0].impact).toContain('1.8%')
  expect(target.value).toBe(0.018)
})
