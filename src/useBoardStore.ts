import { useCallback, useRef, useState } from 'react'
import type { ActionFeedbackView, ActionItemView, ActionTaskView, BoardView, ReportRecord } from './data'
import type { DashboardDataState } from './useDashboardData'

export interface ManualSuggestInput {
  title: string
  rationale: string
  scene?: string
  lifecycle?: string
  priority?: string
  effort?: string
}

export interface TaskCreateFormInput {
  title: string
  owner?: string
  dueDate?: string
  priority?: string
  note?: string
}

export interface TaskPatchFormInput {
  title?: string
  owner?: string
  dueDate?: string
  priority?: string
  note?: string
  status?: ActionTaskView['status']
}

export interface FeedbackFormInput {
  adopted: boolean
  outcome: string
  metricDelta?: string
  review?: string
  score: number
}

export interface BoardStore {
  /** 写操作失败标志（S9：列表底部 role=alert，已回滚服务器状态） */
  error: boolean
  adopt(item: ActionItemView): void
  dismiss(item: ActionItemView, reason: string): Promise<boolean>
  backfill(item: ActionItemView, reason: string): Promise<boolean>
  /** 返回 false = 提交失败（已回滚），表单保持打开 */
  createManual(input: ManualSuggestInput): Promise<boolean>
  createTask(item: ActionItemView, input: TaskCreateFormInput): Promise<boolean>
  patchTask(item: ActionItemView, task: ActionTaskView, patch: TaskPatchFormInput): Promise<boolean>
  saveFeedback(item: ActionItemView, task: ActionTaskView, input: FeedbackFormInput): Promise<boolean>
  extractReport(report: ReportRecord, force?: boolean): void
}

/**
 * 行动闭环操作仓库（M5）：乐观更新 + 失败回滚为服务器状态。
 * 演示态（view.isDemo）仅本地临态、不落库（G7）。
 */
export function useBoardStore(data: DashboardDataState): BoardStore {
  const { view, setView, refresh } = data
  const [error, setError] = useState(false)

  // view 在回调闭包内会过期，用 ref 保最新值（只读用途）
  const viewRef = useRef<BoardView | null>(view)
  viewRef.current = view

  const applyItem = useCallback(
    (item: ActionItemView) => {
      setView(mergeItem(viewRef.current, item))
    },
    [setView],
  )

  const sendItemRequest = useCallback(
    async (url: string, init: RequestInit, optimistic: ActionItemView): Promise<boolean> => {
      applyItem(optimistic)
      try {
        const res = await fetch(url, {
          headers: { 'content-type': 'application/json' },
          ...init,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const serverItem = (await res.json()) as ActionItemView
        if (serverItem && typeof serverItem === 'object' && typeof serverItem.id === 'string') {
          applyItem(serverItem)
        }
        return true
      } catch {
        setError(true)
        await refresh() // 回滚为服务器状态
        return false
      }
    },
    [applyItem, refresh],
  )

  const adopt = useCallback(
    (item: ActionItemView) => {
      const optimistic: ActionItemView = {
        ...item,
        status: 'adopted',
        decidedAt: new Date().toISOString(),
        decidedVia: 'board',
      }
      if (viewRef.current?.isDemo) {
        applyItem(optimistic)
        return
      }
      void sendItemRequest(`/api/actions/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'adopted', via: 'board' }),
      }, optimistic)
    },
    [applyItem, sendItemRequest],
  )

  const dismiss = useCallback(
    (item: ActionItemView, reason: string) => {
      const optimistic: ActionItemView = {
        ...item,
        status: 'dismissed',
        dismissedReason: reason,
        decidedAt: new Date().toISOString(),
        decidedVia: 'board',
      }
      if (viewRef.current?.isDemo) {
        applyItem(optimistic)
        return Promise.resolve(true)
      }
      return sendItemRequest(`/api/actions/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'dismissed', dismissedReason: reason, via: 'board' }),
      }, optimistic)
    },
    [applyItem, sendItemRequest],
  )

  const backfill = useCallback(
    (item: ActionItemView, reason: string) => {
      const optimistic: ActionItemView = { ...item, dismissedReason: reason }
      if (viewRef.current?.isDemo) {
        applyItem(optimistic)
        return Promise.resolve(true)
      }
      return sendItemRequest(`/api/actions/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ backfillDismissedReason: reason }),
      }, optimistic)
    },
    [applyItem, sendItemRequest],
  )

  const createManual = useCallback(
    async (input: ManualSuggestInput): Promise<boolean> => {
      if (viewRef.current?.isDemo) {
        applyItem(localManualItem(input))
        return true
      }
      try {
        const res = await fetch('/api/actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const serverItem = (await res.json()) as ActionItemView
        applyItem(serverItem)
        return true
      } catch {
        setError(true)
        await refresh()
        return false
      }
    },
    [applyItem, refresh],
  )

  /** 任务/反馈写操作：乐观更新到所属行动项，服务器响应回填，失败回滚（S4/S5） */
  const sendTaskRequest = useCallback(
    async (url: string, init: RequestInit, optimistic: ActionItemView, fold: (payload: unknown) => ActionItemView): Promise<boolean> => {
      applyItem(optimistic)
      try {
        const res = await fetch(url, {
          headers: { 'content-type': 'application/json' },
          ...init,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        applyItem(fold(await res.json()))
        return true
      } catch {
        setError(true)
        await refresh() // 回滚为服务器状态
        return false
      }
    },
    [applyItem, refresh],
  )

  const createTask = useCallback(
    (item: ActionItemView, input: TaskCreateFormInput): Promise<boolean> => {
      const now = new Date().toISOString()
      const optimisticTask: ActionTaskView = {
        id: `local-task-${now}`,
        actionItemId: item.id,
        title: input.title,
        owner: input.owner ?? null,
        dueDate: input.dueDate ?? null,
        status: 'todo',
        priority: input.priority ?? 'medium',
        note: input.note ?? '',
        createdAt: now,
        updatedAt: now,
      }
      const optimistic = withTask(item, optimisticTask)
      if (viewRef.current?.isDemo) {
        applyItem(optimistic)
        return Promise.resolve(true)
      }
      return sendTaskRequest(
        `/api/actions/${encodeURIComponent(item.id)}/tasks`,
        { method: 'POST', body: JSON.stringify(input) },
        optimistic,
        (payload) => withTask(item, asTaskView(payload)),
      )
    },
    [applyItem, sendTaskRequest],
  )

  const patchTask = useCallback(
    (item: ActionItemView, task: ActionTaskView, patch: TaskPatchFormInput): Promise<boolean> => {
      const optimistic = withTask(item, { ...task, ...patch, updatedAt: new Date().toISOString() })
      if (viewRef.current?.isDemo) {
        applyItem(optimistic)
        return Promise.resolve(true)
      }
      return sendTaskRequest(
        `/api/tasks/${encodeURIComponent(task.id)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
        optimistic,
        (payload) => withTask(item, asTaskView(payload)),
      )
    },
    [applyItem, sendTaskRequest],
  )

  const saveFeedback = useCallback(
    (item: ActionItemView, task: ActionTaskView, input: FeedbackFormInput): Promise<boolean> => {
      const optimistic = withTask(item, {
        ...task,
        feedback: {
          adopted: input.adopted,
          outcome: input.outcome,
          metricDelta: input.metricDelta ?? '',
          review: input.review ?? '',
          score: input.score,
          updatedAt: new Date().toISOString(),
        },
      })
      if (viewRef.current?.isDemo) {
        applyItem(optimistic)
        return Promise.resolve(true)
      }
      return sendTaskRequest(
        `/api/tasks/${encodeURIComponent(task.id)}/feedback`,
        { method: 'POST', body: JSON.stringify(input) }, // 一任务一条：重复 POST 覆盖
        optimistic,
        (payload) => withTask(item, { ...task, feedback: asFeedbackView(payload) }),
      )
    },
    [applyItem, sendTaskRequest],
  )

  const extractReport = useCallback(
    (report: ReportRecord, force = false) => {
      if (!viewRef.current) return
      // 乐观置「抽取中」；结果（含失败原因）以刷新后的服务器态为准
      setView({
        ...viewRef.current,
        reports: viewRef.current.reports.map((r) => (r.id === report.id ? { ...r, status: 'extracting' as const, error: null } : r)),
      })
      if (viewRef.current.isDemo) return
      void fetch('/api/reports/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: report.slug, ...(force ? { force: true } : {}) }),
      })
        .then(() => refresh())
        .catch(() => {
          setError(true)
          void refresh()
        })
    },
    [setView, refresh],
  )

  return { error, adopt, dismiss, backfill, createManual, createTask, patchTask, saveFeedback, extractReport }
}

/** 任务并入所属行动项：存在则原位替换，否则追加（列表末尾） */
function withTask(item: ActionItemView, task: ActionTaskView): ActionItemView {
  const exists = item.tasks.some((it) => it.id === task.id)
  return {
    ...item,
    tasks: exists ? item.tasks.map((it) => (it.id === task.id ? task : it)) : [...item.tasks, task],
  }
}

function asTaskView(payload: unknown): ActionTaskView {
  if (typeof payload !== 'object' || payload === null || typeof (payload as ActionTaskView).id !== 'string') {
    throw new Error('任务响应形状非法')
  }
  return payload as ActionTaskView
}

function asFeedbackView(payload: unknown): ActionFeedbackView {
  if (typeof payload !== 'object' || payload === null || typeof (payload as ActionFeedbackView).score !== 'number') {
    throw new Error('反馈响应形状非法')
  }
  return payload as ActionFeedbackView
}

function mergeItem(view: BoardView | null, item: ActionItemView): BoardView {
  if (!view) throw new Error('mergeItem 需要已加载的看板视图')
  const exists = view.actionItems.some((it) => it.id === item.id)
  const actionItems = exists ? view.actionItems.map((it) => (it.id === item.id ? item : it)) : [item, ...view.actionItems]
  return { ...view, actionItems, stats: computeStats(actionItems) }
}

function computeStats(items: ActionItemView[]): BoardView['stats'] {
  return {
    suggested: items.filter((i) => i.status === 'suggested').length,
    adopted: items.filter((i) => i.status === 'adopted').length,
    dismissed: items.filter((i) => i.status === 'dismissed').length,
    manual: items.filter((i) => i.sourceKind === 'manual').length,
  }
}

/** 演示态人工补充：本地构造 manual 项（证据固定经验假设，G11 形态一致） */
function localManualItem(input: ManualSuggestInput): ActionItemView {
  const now = new Date().toISOString()
  return {
    id: `manual-${now}`,
    reportId: null,
    sourceKind: 'manual',
    title: input.title,
    rationale: input.rationale,
    scene: input.scene ?? null,
    lifecycle: input.lifecycle ?? null,
    expectedImpact: '待评估',
    metricRef: null,
    priority: input.priority ?? 'medium',
    effort: input.effort ?? 'medium',
    confidence: null,
    evidence: { facts: [], level: '经验假设', reasoning: input.rationale },
    evidenceLevel: '经验假设',
    status: 'suggested',
    dismissedReason: null,
    decidedBy: null,
    decidedAt: null,
    decidedVia: null,
    createdAt: now,
    updatedAt: now,
    tasks: [],
  }
}
