import { render, screen, within, fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import App from './App'
import { demoData } from './data'

// ECharts canvas 属系统边界：App 级测试 stub 图表组件，图表配置由 MetricChart.test.ts 纯函数测试覆盖
vi.mock('./components/MetricChart', () => ({
  MetricChart: ({ def }: { def: { id: string } }) => <div data-testid={`chart-${def.id}`} />,
}))

const cards = () => screen.getAllByRole('article')

test('应用外壳渲染出页面标题与产品说明句', () => {
  render(<App />)
  expect(screen.getByRole('heading', { level: 1, name: '决策看板' })).toBeInTheDocument()
  expect(screen.getByText(/今天要拍板/)).toBeInTheDocument()
})

test('结论区按严重度排序展示 4 条结论，chip 文字双通道可见', () => {
  render(<App />)
  expect(cards()).toHaveLength(4)
  const chips = cards().map((card) => within(card).getByText(/^(高|中|低)$/).textContent)
  expect(chips).toEqual(['高', '中', '中', '低'])
  expect(within(cards()[0]).getByText(/ROI 0\.72/)).toBeInTheDocument()
})

test('概览头展示数据窗口与更新时间', () => {
  render(<App />)
  expect(screen.getByText(/数据窗口 09-12 ~ 09-25/)).toBeInTheDocument()
  expect(screen.getByText(/更新于 2026-09-25 09:00/)).toBeInTheDocument()
})

test('默认展开第一条结论（最高严重度），其余收起', () => {
  render(<App />)
  expect(within(cards()[0]).getByText('推导链路')).toBeInTheDocument()
  expect(within(cards()[1]).queryByText('推导链路')).not.toBeInTheDocument()
})

test('点击结论头部可展开，且不影响已展开的其他结论（可多开）', () => {
  render(<App />)
  fireEvent.click(within(cards()[1]).getByRole('button', { name: /信息流/ }))
  expect(within(cards()[1]).getByText('推导链路')).toBeInTheDocument()
  expect(within(cards()[0]).getByText('推导链路')).toBeInTheDocument()
  fireEvent.click(within(cards()[0]).getByRole('button', { name: /ROI 0\.72/ }))
  expect(within(cards()[0]).queryByText('推导链路')).not.toBeInTheDocument()
  expect(within(cards()[1]).getByText('推导链路')).toBeInTheDocument()
})

test('展开结论可见推导链路四步：检测→归因→规则匹配→建议', () => {
  render(<App />)
  const chain = within(cards()[0]).getByText('推导链路').closest('section')!
  const steps = within(chain).getAllByRole('listitem')
  expect(steps).toHaveLength(4)
  expect(steps[0].textContent).toContain('检测')
  expect(steps[0].textContent).toContain('连续 3 日低于止损线')
  expect(steps[1].textContent).toContain('归因')
  expect(steps[2].textContent).toContain('规则匹配')
  expect(steps[3].textContent).toContain('建议')
})

test('归因明细表按 |贡献| 降序，含正负号文本', () => {
  render(<App />)
  const table = within(cards()[0]).getByRole('table')
  const rows = within(table).getAllByRole('row')
  expect(rows).toHaveLength(4)
  expect(rows[1].textContent).toMatch(/品牌专享词组/)
  expect(rows[1].textContent).toContain('-0.42')
  expect(rows[2].textContent).toMatch(/通用词组/)
  expect(rows[2].textContent).toContain('+0.08')
})

test('核心指标图按结论引用的指标渲染', () => {
  render(<App />)
  expect(within(cards()[0]).getByTestId('chart-roi-search-a')).toBeInTheDocument()
})

test('建议行动展示动作与预期影响，状态默认待定、点击采纳生效', () => {
  render(<App />)
  const card = cards()[0]
  expect(within(card).getByText('止损约 ¥1,400/日')).toBeInTheDocument()
  const pending = within(card).getByRole('button', { name: '待定' })
  const accept = within(card).getByRole('button', { name: '采纳' })
  expect(pending).toHaveAttribute('aria-pressed', 'true')
  expect(accept).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(accept)
  expect(accept).toHaveAttribute('aria-pressed', 'true')
  expect(pending).toHaveAttribute('aria-pressed', 'false')
})

const summary = () => screen.getByRole('region', { name: '行动汇总' })

test('行动汇总区：聚合全部行动与状态计数', () => {
  render(<App />)
  const section = summary()
  expect(within(section).getByRole('button', { name: '全部 4' })).toBeInTheDocument()
  expect(within(section).getByRole('button', { name: '待定 4' })).toBeInTheDocument()
  expect(within(section).getByRole('button', { name: '采纳 0' })).toBeInTheDocument()
  expect(within(section).getByText('止损约 ¥1,400/日')).toBeInTheDocument()
})

test('汇总区与结论卡状态联动（同一状态源）', () => {
  render(<App />)
  fireEvent.click(within(summary()).getAllByRole('button', { name: '采纳' })[0])
  expect(within(summary()).getByRole('button', { name: '待定 3' })).toBeInTheDocument()
  expect(within(summary()).getByRole('button', { name: '采纳 1' })).toBeInTheDocument()
  expect(within(cards()[0]).getByRole('button', { name: '采纳' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('汇总区可按状态过滤行动列表', () => {
  render(<App />)
  fireEvent.click(within(cards()[0]).getByRole('button', { name: '采纳' }))
  fireEvent.click(within(summary()).getByRole('button', { name: '待定 3' }))
  const section = summary()
  expect(within(section).queryByText('止损约 ¥1,400/日')).not.toBeInTheDocument()
  expect(within(section).getByText('追加渠道B日预算 20%（¥3,000 → ¥3,600）')).toBeInTheDocument()
  fireEvent.click(within(section).getByRole('button', { name: '全部 4' }))
  expect(within(section).getByText('止损约 ¥1,400/日')).toBeInTheDocument()
})

test('空数据时显示空状态而非白屏', () => {
  const emptyData = { ...demoData, conclusions: [], series: [], metrics: [] }
  render(<App data={emptyData} />)
  expect(screen.getByText(/暂无需要拍板的结论/)).toBeInTheDocument()
  expect(screen.queryByRole('article')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '全部 0' })).toBeInTheDocument()
})

test('行动可驳回：状态与汇总计数联动（负例路径）', () => {
  render(<App />)
  const card = cards()[0]
  fireEvent.click(within(card).getByRole('button', { name: '驳回' }))
  expect(within(card).getByRole('button', { name: '驳回' })).toHaveAttribute('aria-pressed', 'true')
  expect(within(card).getByRole('button', { name: '待定' })).toHaveAttribute('aria-pressed', 'false')
  expect(within(summary()).getByRole('button', { name: '驳回 1' })).toBeInTheDocument()
  expect(within(summary()).getByRole('button', { name: '待定 3' })).toBeInTheDocument()
})

test('汇总区空过滤态显示提示（负例路径）', () => {
  render(<App />)
  fireEvent.click(within(summary()).getByRole('button', { name: '采纳 0' }))
  expect(within(summary()).getByText('该状态下暂无行动')).toBeInTheDocument()
})

test('数据缝健壮性：未知指标 id 与空序列不崩溃（负例路径）', () => {
  const oddData = {
    ...demoData,
    metrics: [],
    series: [{ metricId: 'ghost', points: [], baselines: [] }],
    conclusions: [
      {
        ...demoData.conclusions[0],
        id: 'cx',
        metricIds: ['unknown-metric'],
      },
    ],
  }
  render(<App data={oddData} />)
  expect(screen.getByText(/ROI 0\.72/)).toBeInTheDocument()
  expect(within(cards()[0]).getByText(/指标缺失/)).toBeInTheDocument()
  expect(screen.queryByTestId('chart-unknown-metric')).not.toBeInTheDocument()
})
