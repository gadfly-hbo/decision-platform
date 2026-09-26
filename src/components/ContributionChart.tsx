import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { BreakdownRow } from '../data'
import { formatWanDelta } from '../data'

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

/** 与 tokens.css 的 --ok / --fail 同值（图表 JS 侧无法引用 CSS 变量） */
const POS_COLOR = '#166534'
const NEG_COLOR = '#b91c1c'

export interface ContributionOption {
  xAxis: { type: 'value' }
  yAxis: { type: 'category'; data: string[] }
  series: Array<{
    type: 'bar'
    data: Array<{
      value: number
      itemStyle: { color: string }
      label: { show: true; position: 'right' | 'left'; formatter: string }
    }>
  }>
}

/** 标签量纲：wan=金额（万元，REVIEW cycle 3 前的硬编码）；count=人数（带符号千分位） */
export type ContributionLabelFormat = 'wan' | 'count'

const formatCountDelta = (v: number): string =>
  `${v >= 0 ? '+' : '-'}${Math.round(Math.abs(v)).toLocaleString('zh-CN')}`

/** 纯函数：归因贡献横向条形图配置。按 |贡献| 降序、最大者在顶部；正绿负红；标签按指标量纲格式化。 */
export function buildContributionOption(
  rows: BreakdownRow[],
  labelFormat: ContributionLabelFormat = 'wan',
): ContributionOption {
  const sorted = [...rows].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
  const bottomToTop = [...sorted].reverse()
  return {
    xAxis: { type: 'value' },
    yAxis: { type: 'category', data: bottomToTop.map((r) => r.dimension) },
    series: [
      {
        type: 'bar',
        data: bottomToTop.map((r) => ({
          value: r.contribution,
          itemStyle: { color: r.contribution >= 0 ? POS_COLOR : NEG_COLOR },
          // 负值条标签放左侧（远离零轴），避免与相邻条重叠（REVIEW cycle 1）
          label: {
            show: true as const,
            position: (r.contribution >= 0 ? 'right' : 'left') as 'right' | 'left',
            formatter: labelFormat === 'wan' ? formatWanDelta(r.contribution) : formatCountDelta(r.contribution),
          },
        })),
      },
    ],
  }
}

interface ContributionChartProps {
  rows: BreakdownRow[]
  metricName: string
  /** 标签量纲：金额指标用万，人数指标用带符号人数（REVIEW cycle 3） */
  labelFormat?: ContributionLabelFormat
}

/** 归因贡献条形图（截面数据的证据区图表）：薄封装 init / setOption / resize / dispose。 */
export function ContributionChart({ rows, metricName, labelFormat = 'wan' }: ContributionChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || rows.length === 0) return
    const chart = echarts.init(el)
    chart.setOption(
      buildContributionOption(rows, labelFormat) as unknown as Parameters<typeof chart.setOption>[0],
    )
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => chart.resize()) : null
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      chart.dispose()
    }
  }, [rows, labelFormat])

  if (rows.length === 0) {
    return <p className="empty-lite">暂无可展示的归因贡献</p>
  }

  return (
    <figure className="metric-chart-wrap">
      <div className="metric-chart" ref={containerRef} role="img" aria-label={`${metricName}归因贡献`} />
      <figcaption className="metric-caliber">
        {metricName}归因贡献（本期 − 同期；绿 = 拉动，红 = 拖累）
      </figcaption>
    </figure>
  )
}
