import type { BreakdownRow, MetricDef } from '../data'
import { formatMetricValue } from '../data'

interface BreakdownTableProps {
  rows: BreakdownRow[]
  /** 贡献与当前值所属的指标（取结论首个引用指标），负 = 拉低指标、正 = 推高 */
  metricDef: MetricDef
}

export function BreakdownTable({ rows, metricDef }: BreakdownTableProps) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
      <thead>
        <tr>
          <th>维度</th>
          <th>对偏离的贡献</th>
          <th>当前值</th>
          <th>变化</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.dimension}>
            <td>{row.dimension}</td>
            <td className={row.contribution >= 0 ? 'pos' : 'neg'}>
              {row.contribution >= 0
                ? `+${row.contribution.toFixed(2)}`
                : row.contribution.toFixed(2)}
            </td>
            <td>{formatMetricValue(metricDef, row.value)}</td>
            <td>{row.delta}</td>
          </tr>
        ))}
      </tbody>
      </table>
    </div>
  )
}
