import { useState } from 'react'
import type { ActionStatus, Conclusion } from '../data'
import { ActionItem } from './ActionItem'
import { STATUS_OPTIONS } from './statusLabels'

type Filter = ActionStatus | 'all'

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  ...STATUS_OPTIONS,
]

interface ActionSummaryProps {
  conclusions: Conclusion[]
  actionStatus: Record<string, ActionStatus>
  onActionStatusChange: (actionId: string, status: ActionStatus) => void
}

export function ActionSummary({ conclusions, actionStatus, onActionStatusChange }: ActionSummaryProps) {
  const [filter, setFilter] = useState<Filter>('all')

  const actions = conclusions.flatMap((conclusion) => conclusion.actions)
  const statusOf = (actionId: string): ActionStatus => actionStatus[actionId] ?? 'pending'
  const countOf = (value: Filter) =>
    value === 'all' ? actions.length : actions.filter((a) => statusOf(a.id) === value).length
  const visible =
    filter === 'all' ? actions : actions.filter((a) => statusOf(a.id) === filter)

  return (
    <section className="action-summary" aria-label="行动汇总">
      <h2 className="view-title">行动汇总</h2>
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
            onStatusChange={(status) => onActionStatusChange(action.id, status)}
          />
        ))
      )}
    </section>
  )
}
