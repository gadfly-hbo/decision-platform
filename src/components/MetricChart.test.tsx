import { render } from '@testing-library/react'
import { afterAll, vi } from 'vitest'
import { buildMetricOption, MetricChart } from './MetricChart'
import { demoData } from '../data'

const def = demoData.metrics.find((m) => m.id === 'roi-search-a')!
const series = demoData.series.find((s) => s.metricId === 'roi-search-a')!

test('图表配置：14 个日期类目，序列末值 0.72', () => {
  const option = buildMetricOption(def, series)
  expect(option.xAxis.data).toHaveLength(14)
  expect(option.xAxis.data[0]).toBe('09-12')
  expect(option.series[0].data[13]).toBe(0.72)
})

test('图表配置：止损线进入 markLine，带标签', () => {
  const option = buildMetricOption(def, series)
  const markLine = option.series[0].markLine.data
  expect(markLine).toHaveLength(1)
  expect(markLine[0].yAxis).toBe(1.0)
  expect(markLine[0].label.formatter).toBe('止损线 1.0')
})

test('图表配置：百分比指标的轴标签做 ×100 换算', () => {
  const cvrDef = demoData.metrics.find((m) => m.id === 'cvr-overall')!
  const cvrSeries = demoData.series.find((s) => s.metricId === 'cvr-overall')!
  const option = buildMetricOption(cvrDef, cvrSeries)
  expect(option.yAxis.axisLabel.formatter).toBe('{value}%')
  // 换算后的值域：0.028 → 2.8
  expect(option.series[0].data[13]).toBe(2.8)
})

// ECharts 渲染引擎是系统边界：mock echarts/core，验证薄封装的公开契约
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

test('图表薄封装：挂载即 init+setOption，容器尺寸变化触发 resize，卸载时 dispose', () => {
  const globalScope = globalThis as { ResizeObserver?: unknown }
  globalScope.ResizeObserver = FakeResizeObserver

  const { unmount } = render(<MetricChart def={def} series={series} />)
  expect(chartMocks.setOption).toHaveBeenCalledTimes(1)
  const option = chartMocks.setOption.mock.calls[0][0]
  expect(option.series[0].markLine.data).toHaveLength(1)

  chartMocks.observerCallback?.()
  expect(chartMocks.resize).toHaveBeenCalled()

  unmount()
  expect(chartMocks.dispose).toHaveBeenCalled()
  expect(chartMocks.dispose).toHaveBeenCalledTimes(1)
})

test('图表薄封装：空序列防御，不初始化图表也不崩溃', () => {
  chartMocks.setOption.mockClear()
  const emptySeries = { metricId: def.id, points: [], baselines: [] }
  const { unmount } = render(<MetricChart def={def} series={emptySeries} />)
  expect(chartMocks.setOption).not.toHaveBeenCalled()
  unmount()
})
