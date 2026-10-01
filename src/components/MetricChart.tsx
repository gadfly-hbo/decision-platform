import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, MarkLineComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { MetricDef, MetricSeries } from '../data'
import { formatMetricValue } from '../data'

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer])

/** 与 tokens.css 的 --navy / --warn 同值（图表 JS 侧无法引用 CSS 变量） */
const LINE_COLOR = '#263442'
const BASELINE_COLOR = '#855211'

export interface MetricOption {
  xAxis: { type: 'category'; data: string[] }
  yAxis: { type: 'value'; scale: boolean; axisLabel: { formatter: string } }
  series: Array<{
    type: 'line'
    data: number[]
    itemStyle: { color: string }
    lineStyle: { color: string }
    markLine: {
      symbol: 'none'
      lineStyle: { color: string; type: 'dashed' }
      data: Array<{ yAxis: number; label: { formatter: string } }>
    }
  }>
}

/** 纯函数：由指标定义与序列构造图表配置。percent 指标的值 ×100 进图，轴标签加 %。 */
export function buildMetricOption(def: MetricDef, series: MetricSeries): MetricOption {
  const isPercent = def.format === 'percent'
  // percent 值 ×100 进图并取 1 位小数（轴/点均按 1 位展示，同时消除浮点噪声）
  const toChartValue = (v: number) => (isPercent ? Math.round(v * 100 * 10) / 10 : v)
  return {
    xAxis: { type: 'category', data: series.points.map((p) => p.date) },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { formatter: isPercent ? '{value}%' : '{value}' },
    },
    series: [
      {
        type: 'line',
        data: series.points.map((p) => toChartValue(p.value)),
        itemStyle: { color: LINE_COLOR },
        lineStyle: { color: LINE_COLOR },
        markLine: {
          symbol: 'none',
          lineStyle: { color: BASELINE_COLOR, type: 'dashed' },
          data: series.baselines.map((b) => ({
            yAxis: toChartValue(b.value),
            label: { formatter: b.label },
          })),
        },
      },
    ],
  }
}

interface MetricChartProps {
  def: MetricDef
  series: MetricSeries
}

/** ECharts 薄封装：init / setOption / resize / dispose。空序列不初始化。 */
export function MetricChart({ def, series }: MetricChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || series.points.length === 0) return
    const chart = echarts.init(el)
    // MetricOption 是结构化子集，setOption 重载要求官方 Option 类型
    chart.setOption(buildMetricOption(def, series) as unknown as Parameters<typeof chart.setOption>[0])
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => chart.resize()) : null
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      chart.dispose()
    }
  }, [def, series])

  if (series.points.length === 0) {
    return <p className="empty-lite">该指标暂无数据点</p>
  }

  return (
    <figure className="metric-chart-wrap">
      <div className="metric-chart" ref={containerRef} role="img" aria-label={def.name} />
      <figcaption className="metric-caliber">
        {def.name}（口径：{def.caliber}）· 当前值{' '}
        {formatMetricValue(def, series.points[series.points.length - 1].value)}
      </figcaption>
    </figure>
  )
}
