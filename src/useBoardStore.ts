import { useCallback, useRef, useState } from 'react'
import type { ActionItemView, BoardView, ProjectSummary, ReportRecord } from './data'
import type { ProjectBoardState } from './useProjectBoard'
import type { ProjectsState } from './useProjects'

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
  status?: import('./data').ActionTaskView['status']
}

export interface FeedbackFormInput {
  adopted: boolean
  outcome: string
  metricDelta?: string
  review?: string
  score: number
}

export interface ProjectPatchInput {
  title?: string
  purpose?: string
}

export interface UploadOutcome {
  filename: string
  ok: boolean
  error?: string
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
  patchTask(item: ActionItemView, task: import('./data').ActionTaskView, patch: TaskPatchFormInput): Promise<boolean>
  saveFeedback(item: ActionItemView, task: import('./data').ActionTaskView, input: FeedbackFormInput): Promise<boolean>
  extractReport(report: ReportRecord, force?: boolean): void
  /** 上传报告（前端预检类型/大小 → POST；返回逐份结果供 S1b 呈现失败项） */
  uploadReports(files: File[]): Promise<UploadOutcome[]>
  createProject(title: string, purpose?: string): Promise<ProjectSummary | null>
  updateProject(id: string, patch: ProjectPatchInput): Promise<boolean>
  /** 删除后返回剩余项目列表（App 据此回退当前项目，G7'） */
  deleteProject(id: string): Promise<ProjectSummary[] | null>
}

export interface BoardStoreDeps {
  projectId: string | null
  board: ProjectBoardState
  projects: ProjectsState
}

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

/**
 * 行动闭环 + 项目操作仓库（M6）：乐观更新 + 失败回滚为服务器状态。
 */
export function useBoardStore(deps: BoardStoreDeps): BoardStore {
  const { projectId, board, projects } = deps
  const { view, setView, refresh } = board
  const [error, setError] = useState(false)

  // view 在回调闭包内会过期，用 ref 保最新值（只读用途）
  const viewRef = useRef<BoardView | null>(view)
  viewRef.current = view
  const projectIdRef = useRef<string | null>(projectId)
  projectIdRef.current = projectId

  const applyItem = useCallback(
    (item: ActionItemView) => {
      setView(mergeItem(viewRef.current, item))
    },
    [setView],
  )

  const rollback = useCallback(async () => {
    setError(true)
    await refresh()
    void projects.refresh()
  }, [refresh, projects])

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
        await rollback()
        return false
      }
    },
    [applyItem, rollback],
  )

  const adopt = useCallback(
    (item: ActionItemView) => {
      const optimistic: ActionItemView = {
        ...item,
        status: 'adopted',
        decidedAt: new Date().toISOString(),
        decidedVia: 'board',
      }
      void sendItemRequest(`/api/actions/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'adopted', via: 'board' }),
      }, optimistic)
    },
    [sendItemRequest],
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
      return sendItemRequest(`/api/actions/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'dismissed', dismissedReason: reason, via: 'board' }),
      }, optimistic)
    },
    [sendItemRequest],
  )

  const backfill = useCallback(
    (item: ActionItemView, reason: string) => {
      const optimistic: ActionItemView = { ...item, dismissedReason: reason }
      return sendItemRequest(`/api/actions/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ backfillDismissedReason: reason }),
      }, optimistic)
    },
    [sendItemRequest],
  )

  const createManual = useCallback(
    async (input: ManualSuggestInput): Promise<boolean> => {
      const currentId = projectIdRef.current
      if (!currentId) return false
      try {
        const res = await fetch('/api/actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: currentId, ...input }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const serverItem = (await res.json()) as ActionItemView
        applyItem(serverItem)
        return true
      } catch {
        await rollback()
        return false
      }
    },
    [applyItem, rollback],
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
        await rollback()
        return false
      }
    },
    [applyItem, rollback],
  )

  const createTask = useCallback(
    (item: ActionItemView, input: TaskCreateFormInput): Promise<boolean> => {
      const now = new Date().toISOString()
      const optimisticTask: import('./data').ActionTaskView = {
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
      return sendTaskRequest(
        `/api/actions/${encodeURIComponent(item.id)}/tasks`,
        { method: 'POST', body: JSON.stringify(input) },
        optimistic,
        (payload) => withTask(item, asTaskView(payload)),
      )
    },
    [sendTaskRequest],
  )

  const patchTask = useCallback(
    (item: ActionItemView, task: import('./data').ActionTaskView, patch: TaskPatchFormInput): Promise<boolean> => {
      const optimistic = withTask(item, { ...task, ...patch, updatedAt: new Date().toISOString() })
      return sendTaskRequest(
        `/api/tasks/${encodeURIComponent(task.id)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
        optimistic,
        (payload) => withTask(item, asTaskView(payload)),
      )
    },
    [sendTaskRequest],
  )

  const saveFeedback = useCallback(
    (item: ActionItemView, task: import('./data').ActionTaskView, input: FeedbackFormInput): Promise<boolean> => {
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
      return sendTaskRequest(
        `/api/tasks/${encodeURIComponent(task.id)}/feedback`,
        { method: 'POST', body: JSON.stringify(input) }, // 一任务一条：重复 POST 覆盖
        optimistic,
        (payload) => withTask(item, { ...task, feedback: asFeedbackView(payload) }),
      )
    },
    [sendTaskRequest],
  )

  const extractReport = useCallback(
    (report: ReportRecord, force = false) => {
      const currentView = viewRef.current
      const currentId = projectIdRef.current
      if (!currentView || !currentId) return
      // 乐观置「抽取中」；结果（含失败原因）以刷新后的服务器态为准
      setView({
        ...currentView,
        reports: currentView.reports.map((r) => (r.id === report.id ? { ...r, status: 'extracting' as const, error: null } : r)),
      })
      void fetch(`/api/projects/${encodeURIComponent(currentId)}/reports/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: report.slug, ...(force ? { force: true } : {}) }),
      })
        .then(async () => {
          await refresh()
          void projects.refresh()
        })
        .catch(() => void rollback())
    },
    [setView, refresh, projects, rollback],
  )

  const uploadReports = useCallback(
    async (files: File[]): Promise<UploadOutcome[]> => {
      const currentId = projectIdRef.current
      const outcomes: UploadOutcome[] = []
      const accepted: Array<{ filename: string; contentBase64: string }> = []
      // 前端预检（G2' 契约文案）：类型/大小；其余校验（UTF-8 等）由后端拒绝并透传原因
      for (const file of files) {
        if (!/\.(md|txt)$/i.test(file.name)) {
          outcomes.push({ filename: file.name, ok: false, error: '仅支持 .md/.txt 文件' })
          continue
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          outcomes.push({ filename: file.name, ok: false, error: '文件超过 2MB' })
          continue
        }
        const buffer = await file.arrayBuffer()
        accepted.push({
          filename: file.name,
          contentBase64: arrayBufferToBase64(buffer),
        })
      }
      if (accepted.length > 0 && currentId) {
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(currentId)}/reports`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ files: accepted }),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = (await res.json()) as { results: Array<{ filename: string; ok: boolean; error?: string }> }
          for (const result of body.results) {
            outcomes.push(result.ok ? { filename: result.filename, ok: true } : { filename: result.filename, ok: false, error: result.error ?? '上传失败' })
          }
        } catch {
          for (const item of accepted) {
            outcomes.push({ filename: item.filename, ok: false, error: '上传失败，请重试' })
          }
        }
      }
      if (outcomes.some((it) => it.ok)) {
        await refresh() // 触发 board 刷新（pending/抽取中状态与轮询）
        void projects.refresh()
      }
      return outcomes
    },
    [refresh, projects],
  )

  const createProject = useCallback(
    async (title: string, purpose?: string): Promise<ProjectSummary | null> => {
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, ...(purpose ? { purpose } : {}) }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const created = (await res.json()) as ProjectSummary
        await projects.refresh()
        return created
      } catch {
        setError(true)
        return null
      }
    },
    [projects],
  )

  const updateProject = useCallback(
    async (id: string, patch: ProjectPatchInput): Promise<boolean> => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await projects.refresh()
        return true
      } catch {
        setError(true)
        return false
      }
    },
    [projects],
  )

  const deleteProject = useCallback(
    async (id: string): Promise<ProjectSummary[] | null> => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await projects.refresh()
      } catch {
        setError(true)
        return null
      }
    },
    [projects],
  )

  return {
    error,
    adopt,
    dismiss,
    backfill,
    createManual,
    createTask,
    patchTask,
    saveFeedback,
    extractReport,
    uploadReports,
    createProject,
    updateProject,
    deleteProject,
  }
}

/** 任务并入所属行动项：存在则原位替换，否则追加（列表末尾） */
function withTask(item: ActionItemView, task: import('./data').ActionTaskView): ActionItemView {
  const exists = item.tasks.some((it) => it.id === task.id)
  return {
    ...item,
    tasks: exists ? item.tasks.map((it) => (it.id === task.id ? task : it)) : [...item.tasks, task],
  }
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

function asTaskView(payload: unknown): import('./data').ActionTaskView {
  if (typeof payload !== 'object' || payload === null || typeof (payload as import('./data').ActionTaskView).id !== 'string') {
    throw new Error('任务响应形状非法')
  }
  return payload as import('./data').ActionTaskView
}

function asFeedbackView(payload: unknown): import('./data').ActionFeedbackView {
  if (typeof payload !== 'object' || payload === null || typeof (payload as import('./data').ActionFeedbackView).score !== 'number') {
    throw new Error('反馈响应形状非法')
  }
  return payload as import('./data').ActionFeedbackView
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
