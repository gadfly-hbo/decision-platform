import { render, screen } from '@testing-library/react'
import { BreakdownTable } from './BreakdownTable'
import type { BreakdownRow, MetricDef } from '../data'

const currencyMetric: MetricDef = {
  id: 'memberSales',
  name: '会员零售额',
  unit: '元',
  caliber: '会员销售额',
  format: 'currency',
}

const rows: BreakdownRow[] = [
  { dimension: '加盟·西南加盟', contribution: 4415386, value: 16101983, delta: '+37.8%' },
  { dimension: '加盟·鲁苏分公司', contribution: -2675712, value: 15185963, delta: '-15.0%' },
]

test('金额指标：贡献与当前值以万元展示（与贡献图口径一致）', () => {
  render(<BreakdownTable rows={rows} metricDef={currencyMetric} />)
  const cells = screen.getAllByRole('cell')
  const text = cells.map((c) => c.textContent).join('|')
  expect(text).toContain('+442 万')
  expect(text).toContain('-268 万')
  expect(text).toContain('1,610 万')
  expect(text).not.toContain('¥')
})

test('非金额指标保持原格式（人数/倍数不变）', () => {
  const peopleMetric: MetricDef = { id: 'memberBuyers', name: '会员购买人数', unit: '人', caliber: '已去重', format: 'number' }
  render(<BreakdownTable rows={[{ dimension: 'x', contribution: -5335, value: 14898, delta: '-26.4%' }]} metricDef={peopleMetric} />)
  const text = screen.getAllByRole('cell').map((c) => c.textContent).join('|')
  expect(text).toContain('-5335.00')
  expect(text).toContain('14,898')
})
