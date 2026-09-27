import type { ActionStatus, SuggestedAction } from '../data'
import type { StoredActionState } from '../useActionStore'
import { STATUS_OPTIONS } from './statusLabels'

interface ActionItemProps {
  action: SuggestedAction
  status: ActionStatus
  /** 已执行时的落地说明（来自后端行动存储） */
  note?: string
  /** 后端行动记录（M4：读取审批留痕 decidedBy/decidedAt/decidedVia） */
  decided?: StoredActionState
  onAction: (patch: { status: ActionStatus; executedNote?: string }) => void
}

function decidedMetaText(d: StoredActionState): string {
  const who = d.decidedBy ?? (d.decidedVia === 'card' ? 'IM 审批' : 'PC')
  const t = new Date(d.decidedAt ?? '')
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${who} · ${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
}

export function ActionItem({ action, status, note, decided, onAction }: ActionItemProps) {
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
        {decided?.decidedAt && <span className="decided-meta">{decidedMetaText(decided)}</span>}
      </div>
    </div>
  )
}
