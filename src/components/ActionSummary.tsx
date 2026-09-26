import { useState } from 'react'
import type { ActionStatus, ActionReviewItem, Conclusion } from '../data'
import { ActionItem } from './ActionItem'
import { STATUS_OPTIONS } from './statusLabels'
import type { StoredActionMap } from '../useActionStore'

type Filter = ActionStatus | 'all'

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  ...STATUS_OPTIONS,
]

const STATUS_LABEL = new Map(STATUS_OPTIONS.map((option) => [option.value, option.label]))

interface ActionSummaryProps {
  conclusions: Conclusion[]
  actionState: StoredActionMap
  onActionAction: (actionId: string, patch: { status: ActionStatus; executedNote?: string }) => void
  actionReview?: ActionReviewItem[]
}

export function ActionSummary({ conclusions, actionState, onActionAction, actionReview }: ActionSummaryProps) {
  const [filter, setFilter] = useState<Filter>('all')

  const actions = conclusions.flatMap((conclusion) => conclusion.actions)
  const statusOf = (actionId: string): ActionStatus => actionState[actionId]?.status ?? 'pending'
  const countOf = (value: Filter) =>
    value === 'all' ? actions.length : actions.filter((a) => statusOf(a.id) === value).length
  const visible = filter === 'all' ? actions : actions.filter((a) => statusOf(a.id) === filter)

  return (
    <section className="action-summary" aria-label="行动汇总">
      <h2 className="view-title">行动汇总</h2>
      {actionReview && actionReview.length > 0 && (
        <div className="action-review">
          <h3 className="review-title">上周行动对照</h3>
          {actionReview.map((item) => (
            <p key={item.actionId} className="review-item">
              <span className={`chip review-chip st-${item.status}`}>
                {STATUS_LABEL.get(item.status) ?? item.status}
              </span>
              <span className="review-text">
                {item.text}
                {item.executedNote ? `（${item.executedNote}）` : ''}
              </span>
              <span className="review-thisweek">→ {item.thisWeek}</span>
            </p>
          ))}
        </div>
      )}
      <div className="summary-filters">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="filter-chip"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label} {countOf(option.value)}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="empty-lite">该状态下暂无行动</p>
      ) : (
        visible.map((action) => (
          <ActionItem
            key={action.id}
            action={action}
            status={statusOf(action.id)}
            note={actionState[action.id]?.executedNote}
            onAction={(patch) => onActionAction(action.id, patch)}
          />
        ))
      )}
    </section>
  )
}
