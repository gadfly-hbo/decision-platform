import type { ActionStatus, SuggestedAction } from '../data'
import { STATUS_OPTIONS } from './statusLabels'

interface ActionItemProps {
  action: SuggestedAction
  status: ActionStatus
  /** 已执行时的落地说明（来自后端行动存储） */
  note?: string
  onAction: (patch: { status: ActionStatus; executedNote?: string }) => void
}

export function ActionItem({ action, status, note, onAction }: ActionItemProps) {
  return (
    <div className="action-item">
      <div className="action-main">
        <span className="action-text">{action.text}</span>
        <span className="action-impact">{action.impact}</span>
        {status === 'executed' && (
          <input
            key={`${action.id}:${note ?? ''}`}
            className="exec-note"
            type="text"
            defaultValue={note}
            placeholder="执行说明（可选）"
            aria-label={`${action.text} 执行说明`}
            onBlur={(event) => onAction({ status: 'executed', executedNote: event.target.value })}
          />
        )}
      </div>
      <div className="action-status" role="group" aria-label="行动状态">
        {STATUS_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`status-btn st-${option.value}`}
            aria-pressed={status === option.value}
            onClick={() => onAction({ status: option.value })}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
