import { render } from '@testing-library/react'
import { afterAll, vi } from 'vitest'
import { buildContributionOption, ContributionChart } from './ContributionChart'
import type { BreakdownRow } from '../data'

const rows: BreakdownRow[] = [
  { dimension: '加盟·西南加盟', contribution: 4415386, value: 16101983, delta: '+37.8%' },
  { dimension: '直营·广州子公司', contribution: 2895906, value: 10808241, delta: '+36.6%' },
  { dimension: '加盟·鲁苏分公司', contribution: -2675712, value: 15185963, delta: '-15.0%' },
  { dimension: '加盟·湖北分公司', contribution: -1189774, value: 9276219, delta: '-11.4%' },
]

test('贡献图配置：按 |贡献| 降序、最大者在顶部（类目倒序）', () => {
  const option = buildContributionOption(rows)
  expect(option.yAxis.data).toEqual([
    '加盟·湖北分公司',
    '加盟·鲁苏分公司',
    '直营·广州子公司',
    '加盟·西南加盟',
  ])
  expect(option.series[0].data.map((d) => d.value)).toEqual([-1189774, -2675712, 2895906, 4415386])
})

test('贡献图配置：正负分色（正=ok 绿，负=fail 红，与 Xanthil token 同值）', () => {
  const option = buildContributionOption(rows)
  const colors = option.series[0].data.map((d) => d.itemStyle.color)
  expect(colors).toEqual(['#952f2f', '#952f2f', '#176247', '#176247'])
})

test('贡献图配置：数值标签预格式化为万元（带符号）', () => {
  const option = buildContributionOption(rows)
  const labels = option.series[0].data.map((d) => d.label.formatter)
  expect(labels).toEqual(['-119 万', '-268 万', '+290 万', '+442 万'])
})

// ECharts 渲染引擎是系统边界：mock echarts/core，验证薄封装契约
const chartMocks = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  observerCallback: undefined as undefined | (() => void),
}))

vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({
    setOption: chartMocks.setOption,
    resize: chartMocks.resize,
    dispose: chartMocks.dispose,
  })),
}))

class FakeResizeObserver {
  constructor(callback: () => void) {
    chartMocks.observerCallback = callback
  }
  observe = vi.fn()
  disconnect = vi.fn()
}

afterAll(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

test('贡献图薄封装：挂载 init+setOption，resize 触发，卸载 dispose', () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
  const { unmount } = render(<ContributionChart rows={rows} metricName="会员零售额" />)
  expect(chartMocks.setOption).toHaveBeenCalledTimes(1)
  const option = chartMocks.setOption.mock.calls[0][0]
  expect(option.yAxis.data).toHaveLength(4)

  chartMocks.observerCallback?.()
  expect(chartMocks.resize).toHaveBeenCalled()

  unmount()
  expect(chartMocks.dispose).toHaveBeenCalledTimes(1)
})

test('贡献图配置：负值条标签在左、正值在右（按符号分侧）', () => {
  const option = buildContributionOption(rows)
  const positions = option.series[0].data.map((d) => d.label.position)
  expect(positions).toEqual(['left', 'left', 'right', 'right'])
})

test('人数指标（count 格式）：标签为带符号千分位，不出现「万」', () => {
  const peopleRows: BreakdownRow[] = [
    { dimension: '加盟·鲁苏分公司', contribution: -5335, value: 14898, delta: '-26.4%' },
    { dimension: '直营·广州子公司', contribution: 3109, value: 16997, delta: '+20.7%' },
  ]
  const option = buildContributionOption(peopleRows, 'count')
  expect(option.series[0].data.map((d) => d.label.formatter)).toEqual(['+3,109', '-5,335'])
  expect(JSON.stringify(option)).not.toContain('万')
})
