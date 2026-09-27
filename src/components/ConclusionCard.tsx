import type { ActionStatus, Conclusion, MetricDef, MetricSeries } from '../data'
import type { StoredActionMap } from '../useActionStore'
import { DerivationChain } from './DerivationChain'
import { MetricChart } from './MetricChart'
import { ContributionChart } from './ContributionChart'
import { BreakdownTable } from './BreakdownTable'
import { ActionItem } from './ActionItem'

const SEVERITY_LABEL: Record<Conclusion['severity'], string> = {
  high: '高',
  medium: '中',
  low: '低',
}

interface ConclusionCardProps {
  conclusion: Conclusion
  expanded: boolean
  onToggle: () => void
  metricFor: (id: string) => MetricDef | undefined
  seriesFor: (id: string) => MetricSeries | undefined
  actionState: StoredActionMap
  onActionAction: (actionId: string, patch: { status: ActionStatus; executedNote?: string }) => void
}

export function ConclusionCard({
  conclusion,
  expanded,
  onToggle,
  metricFor,
  seriesFor,
  actionState,
  onActionAction,
}: ConclusionCardProps) {
  const primaryMetric = metricFor(conclusion.metricIds[0])

  return (
    <article className={`conclusion-card sev-${conclusion.severity}`}>
      <button type="button" className="conclusion-head" aria-expanded={expanded} onClick={onToggle}>
        <span className={`chip sev-${conclusion.severity}`}>{SEVERITY_LABEL[conclusion.severity]}</span>
        <span className="head-main">
          <span className="card-title">{conclusion.title}</span>
          <span className="conclusion-summary">{conclusion.summary}</span>
        </span>
        <span className="head-meta">
          {conclusion.window}
          <span className="chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="evidence">
          <section className="evidence-block">
            <h3 className="block-title">推导链路</h3>
            <DerivationChain steps={conclusion.derivation} />
          </section>
          <section className="evidence-block">
            <h3 className="block-title">核心指标</h3>
            {conclusion.metricIds.some((metricId) => seriesFor(metricId)) ? (
              conclusion.metricIds.map((metricId) => {
                const def = metricFor(metricId)
                const series = seriesFor(metricId)
                if (!def || !series) return null
                return <MetricChart key={metricId} def={def} series={series} />
              })
            ) : conclusion.breakdown.length > 0 && primaryMetric ? (
              <ContributionChart
                rows={conclusion.breakdown}
                metricName={primaryMetric.name}
                labelFormat={primaryMetric.format === 'currency' ? 'wan' : 'count'}
              />
            ) : (
              <p className="empty-lite">该结论暂无可视化指标</p>
            )}
          </section>
          <section className="evidence-block">
            <h3 className="block-title">归因明细</h3>
            {primaryMetric ? (
              <BreakdownTable rows={conclusion.breakdown} metricDef={primaryMetric} />
            ) : (
              <p className="empty-lite">引用指标缺失，无法格式化归因值</p>
            )}
          </section>
          <section className="evidence-block">
            <h3 className="block-title">建议行动</h3>
            {conclusion.actions.map((action) => (
              <ActionItem
                key={action.id}
                action={action}
                status={actionState[action.id]?.status ?? 'pending'}
                note={actionState[action.id]?.executedNote}
                decided={actionState[action.id]}
                onAction={(patch) => onActionAction(action.id, patch)}
              />
            ))}
          </section>
        </div>
      )}
    </article>
  )
}
