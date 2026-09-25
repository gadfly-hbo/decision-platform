import type { ActionStatus } from '../data'

export const STATUS_OPTIONS: ReadonlyArray<{ value: ActionStatus; label: string }> = [
  { value: 'pending', label: '待定' },
  { value: 'accepted', label: '采纳' },
  { value: 'rejected', label: '驳回' },
]
