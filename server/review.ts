import type { ActionStore } from './actions'
import type { Conclusion } from '../src/data/types'
import type { MetricKey, WeeklyReport } from './report/types'
import { yoy } from './report/types'
import { formatWanDelta, formatPctDelta } from '../src/data/format'
import { MEMBER_METRIC_DEFS } from './rules/metricDefs'

const METRIC_NAME = new Map(MEMBER_METRIC_DEFS.map((def) => [def.id, def.name]))

/** 本期表现摘要：按维度匹配渠道行，指标跟随行动所属结论的 metricIds[0]（REVIEW M3-cycle2），数字可由本期 CSV 复算 */
function thisWeekText(dimension: string | undefined, actionId: string, conclusions: Conclusion[], report: WeeklyReport): string {
  if (dimension) {
    const row = report.rows.find((r) => `${r.mode}·${r.channel}` === dimension)
    if (row) {
      const owner = conclusions.find((c) => c.actions.some((a) => a.id === actionId))
      const metricKey = (owner?.metricIds[0] ?? 'memberSales') as MetricKey
      const metric = row.metrics[metricKey]
      const pct = yoy(metric)
      const name = METRIC_NAME.get(metricKey) ?? metricKey
      const isMoney = metricKey.includes('Sales')
      return `${name}${pct === null ? '同期无基数' : `同比 ${formatPctDelta(pct)}`}，偏离 ${isMoney ? formatWanDelta(metric.current - metric.previous) : `${metric.current - metric.previous >= 0 ? '+' : ''}${Math.round(metric.current - metric.previous).toLocaleString('zh-CN')} 人`}`
    }
  }
  const stillPresent = conclusions.find((c) => c.actions.some((a) => a.id === actionId))
  if (stillPresent) return `本期结论仍在：${stillPresent.title}`
  return '本期无相关异动'
}

/** 跨周行动对照：仅 已采纳/已执行 且 属于往期（period ≠ 本期）的行动进入对照（M3，后端装配） */
export function buildActionReview(
  store: ActionStore,
  conclusions: Conclusion[],
  report: WeeklyReport,
): import('../src/data/types').ActionReviewItem[] {
  return Object.entries(store)
    .filter(
      ([, record]) =>
        (record.status === 'accepted' || record.status === 'executed') &&
        record.period !== '' &&
        record.period !== report.period,
    )
    .map(([actionId, record]) => ({
      actionId,
      text: record.text ?? actionId,
      status: record.status,
      ...(record.executedNote ? { executedNote: record.executedNote } : {}),
      period: record.period,
      thisWeek: thisWeekText(record.dimension, actionId, conclusions, report),
    }))
}
