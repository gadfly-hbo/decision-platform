import { sortConclusions, formatMetricValue } from './index'
import type { Conclusion, MetricDef } from './index'

const makeConclusion = (id: string, severity: Conclusion['severity']): Conclusion =>
  ({ id, severity }) as unknown as Conclusion

test('结论按严重度排序：高 → 中 → 低', () => {
  const shuffled = [
    makeConclusion('low-1', 'low'),
    makeConclusion('mid-1', 'medium'),
    makeConclusion('high-1', 'high'),
    makeConclusion('mid-2', 'medium'),
  ]
  expect(sortConclusions(shuffled).map((c) => c.id)).toEqual(['high-1', 'mid-1', 'mid-2', 'low-1'])
})

test('排序不修改原数组', () => {
  const original = [makeConclusion('low-1', 'low'), makeConclusion('high-1', 'high')]
  const sorted = sortConclusions(original)
  expect(original.map((c) => c.id)).toEqual(['low-1', 'high-1'])
  expect(sorted.map((c) => c.id)).toEqual(['high-1', 'low-1'])
})

const percentMetric: MetricDef = {
  id: 'cvr',
  name: '转化率',
  unit: '%',
  caliber: '订单数 / 访问数',
  format: 'percent',
}

test('指标格式化：百分比保留 1 位小数', () => {
  expect(formatMetricValue(percentMetric, 0.028)).toBe('2.8%')
  expect(formatMetricValue(percentMetric, 0.194)).toBe('19.4%')
})

test('指标格式化：倍数与金额', () => {
  const roiMetric: MetricDef = { id: 'roi', name: 'ROI', unit: '倍', caliber: 'GMV/消耗', format: 'x' }
  expect(formatMetricValue(roiMetric, 2.1)).toBe('2.1')
  expect(formatMetricValue(roiMetric, 0.72)).toBe('0.72')
  const spendMetric: MetricDef = {
    id: 'spend',
    name: '日消耗',
    unit: '元',
    caliber: '当日渠道扣费',
    format: 'currency',
  }
  expect(formatMetricValue(spendMetric, 12345)).toBe('¥12,345')
})
