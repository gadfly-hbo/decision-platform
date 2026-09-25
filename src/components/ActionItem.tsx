import type { ActionStatus, SuggestedAction } from '../data'
import { STATUS_OPTIONS } from './statusLabels'

interface ActionItemProps {
  action: SuggestedAction
  status: ActionStatus
  onStatusChange: (status: ActionStatus) => void
}

export function ActionItem({ action, status, onStatusChange }: ActionItemProps) {
  return (
    <div className="action-item">
      <div className="action-main">
        <span className="action-text">{action.text}</span>
        <span className="action-impact">{action.impact}</span>
      </div>
      <div className="action-status" role="group" aria-label="行动状态">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`status-btn st-${option.value}`}
            aria-pressed={status === option.value}
            onClick={() => onStatusChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
