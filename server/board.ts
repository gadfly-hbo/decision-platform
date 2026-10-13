import type { BoardDb } from './db'
import {
  createActionItem,
  createActionTask,
  deleteActionItem,
  getActionFeedback,
  getActionItem,
  getActionTask,
  getProject,
  listActionItems,
  listAllFeedback,
  listAllTasks,
  listReports,
  saveActionFeedback,
  updateActionItem,
  updateActionTask,
  type ActionTaskRecord,
  type ActionTaskStatus,
} from './db'
import type {
  ActionFeedbackRecord,
  ActionFeedbackView,
  ActionItemView,
  ActionTaskView,
  BoardView,
} from '../src/data/types'
import { ACTION_LIFECYCLES, ACTION_LEVELS, ACTION_SCENES } from './agent/normalize'
import { modelChainAvailable, modelChainStatus } from './agent/model'

export type {
  ActionFeedbackView,
  ActionItemView,
  ActionTaskView,
  BoardStats,
  BoardView,
} from '../src/data/types'

/**
 * 行动闭环看板聚合与生命周期规则（M5）：
 * - G10 驳回必填理由（看板渠道）/卡片默认值+补填一次；
 * - G11 人工补充建议（证据固定经验假设，confidence 空）；
 * - 状态机 suggested→adopted/dismissed，adopted→dismissed（改判需理由）；dismissed 不可直接改采纳（保护决策资产）。
 */

export const CARD_DISMISS_DEFAULT_REASON = '卡片驳回（未填理由）'

const LEDE = '报告驱动的行动闭环：从分析报告提取决策建议，确认后拆解任务、执行后回录反馈，证据可展开核查。'

function taskView(task: ActionTaskRecord, feedbackByTask: Map<string, ActionFeedbackRecord>): ActionTaskView {
  const fb = feedbackByTask.get(task.id)
  return {
    ...task,
    ...(fb
      ? { feedback: { adopted: fb.adopted, outcome: fb.outcome, metricDelta: fb.metricDelta, review: fb.review, score: fb.score, updatedAt: fb.updatedAt } }
      : {}),
  }
}

/** M6：项目作用域 board 聚合；项目不存在 → null（路由层 404）。 */
export function buildBoardView(
  db: BoardDb,
  projectId: string,
  options: { notifyConfigured: boolean; imConfigured?: boolean; lastPushedReport?: string },
): BoardView | null {
  const project = getProject(db, projectId)
  if (!project) return null
  const reports = listReports(db, projectId)
  const items = listActionItems(db, { projectId })
  const tasks = listAllTasks(db)
  const feedback = listAllFeedback(db)
  const feedbackByTask = new Map(feedback.map((fb) => [fb.taskId, fb]))
  const tasksByItem = new Map<string, ActionTaskView[]>()
  for (const task of tasks) {
    const list = tasksByItem.get(task.actionItemId) ?? []
    list.push(taskView(task, feedbackByTask))
    tasksByItem.set(task.actionItemId, list)
  }
  const actionItems: ActionItemView[] = items.map((item) => ({ ...item, tasks: tasksByItem.get(item.id) ?? [] }))
  return {
    title: '决策看板',
    lede: LEDE,
    project: { id: project.id, title: project.title, purpose: project.purpose },
    reports,
    actionItems,
    stats: {
      suggested: actionItems.filter((i) => i.status === 'suggested').length,
      adopted: actionItems.filter((i) => i.status === 'adopted').length,
      dismissed: actionItems.filter((i) => i.status === 'dismissed').length,
      manual: actionItems.filter((i) => i.sourceKind === 'manual').length,
    },
    notify: {
      configured: options.notifyConfigured,
      ...(options.imConfigured !== undefined ? { imConfigured: options.imConfigured } : {}),
      ...(options.lastPushedReport !== undefined && options.lastPushedReport !== ''
        ? { lastPushedReport: options.lastPushedReport }
        : {}),
    },
    modelChain: { available: modelChainAvailable(), providers: modelChainStatus() },
    isDemo: reports.length === 0 && actionItems.length === 0,
  }
}

// ---- G10：确认/驳回状态机 ----

export interface ActionPatchInput {
  status?: unknown
  dismissedReason?: unknown
  backfillDismissedReason?: unknown
  via?: unknown
  decidedBy?: unknown
}

export type ActionPatchOutcome =
  | { ok: true; item: ActionItemView }
  | { ok: false; status: number; error: string }

function itemView(db: BoardDb, id: string): ActionItemView | null {
  const item = getActionItem(db, id)
  if (!item) return null
  const tasks = listAllTasks(db)
    .filter((t) => t.actionItemId === id)
    .map((t) => taskView(t, new Map(listAllFeedback(db).map((fb) => [fb.taskId, fb]))))
  return { ...item, tasks }
}

export function applyActionPatch(db: BoardDb, id: string, input: ActionPatchInput): ActionPatchOutcome {
  const item = getActionItem(db, id)
  if (!item) return { ok: false, status: 404, error: `行动项不存在：${id}` }

  const via = input.via === 'card' ? 'card' : 'board'
  const decidedBy = typeof input.decidedBy === 'string' && input.decidedBy.trim() !== '' ? input.decidedBy.trim() : undefined
  const nextStatus = typeof input.status === 'string' ? input.status : undefined
  const dismissedReason = typeof input.dismissedReason === 'string' ? input.dismissedReason.trim() : undefined
  const backfill = typeof input.backfillDismissedReason === 'string' ? input.backfillDismissedReason.trim() : undefined

  // 补填：仅 dismissed 项 + 卡片默认理由可覆盖一次（G10）
  if (backfill !== undefined) {
    if (item.status !== 'dismissed') return { ok: false, status: 400, error: '仅已驳回的项可补填理由' }
    if (item.dismissedReason !== CARD_DISMISS_DEFAULT_REASON) {
      return { ok: false, status: 400, error: '该驳回理由已填写，不可覆盖（保护已沉淀决策）' }
    }
    if (backfill.length < 2) return { ok: false, status: 400, error: '补填理由至少 2 个字' }
    updateActionItem(db, id, { dismissedReason: backfill })
    const updated = itemView(db, id)
    return updated ? { ok: true, item: updated } : { ok: false, status: 404, error: '行动项不存在' }
  }

  // 看板渠道对已驳回项直接改写理由 → 拒绝（补填是唯一入口）
  if (dismissedReason !== undefined && item.status === 'dismissed' && nextStatus === undefined) {
    return { ok: false, status: 400, error: '驳回理由不可直接改写；卡片渠道驳回可用补填' }
  }

  if (nextStatus === undefined) {
    return { ok: false, status: 400, error: '缺少 status（suggested/adopted/dismissed）' }
  }
  if (nextStatus !== 'adopted' && nextStatus !== 'dismissed') {
    return { ok: false, status: 400, error: 'status 只能是 adopted 或 dismissed' }
  }
  if (item.status === 'dismissed' && nextStatus === 'adopted') {
    return { ok: false, status: 400, error: '已驳回项不可直接改采纳；如需恢复请重新抽取或人工补充' }
  }
  // N2：已驳回项换理由再驳回 → 拒绝（理由是已沉淀的决策资产；补填是唯一覆盖入口，且仅限卡片默认理由）
  if (
    item.status === 'dismissed' &&
    nextStatus === 'dismissed' &&
    dismissedReason !== undefined &&
    dismissedReason !== item.dismissedReason
  ) {
    return { ok: false, status: 400, error: '驳回理由不可改写；如需修正请使用补填（仅卡片渠道默认理由）' }
  }

  if (nextStatus === 'dismissed') {
    let reason: string | undefined
    if (item.status === 'dismissed' && (dismissedReason === undefined || dismissedReason === item.dismissedReason)) {
      // 幂等：重复驳回同理由 → 返回当前态
      const current = itemView(db, id)
      return current ? { ok: true, item: current } : { ok: false, status: 404, error: '行动项不存在' }
    }
    if (via === 'board') {
      if (dismissedReason === undefined || dismissedReason.length < 2) {
        return { ok: false, status: 400, error: '请填写驳回理由（至少 2 个字）' }
      }
      reason = dismissedReason
    } else {
      reason = dismissedReason && dismissedReason.length >= 2 ? dismissedReason : CARD_DISMISS_DEFAULT_REASON
    }
    updateActionItem(db, id, { status: 'dismissed', dismissedReason: reason, decidedBy, decidedVia: via })
  } else {
    if (item.status === 'adopted') {
      const current = itemView(db, id)
      return current ? { ok: true, item: current } : { ok: false, status: 404, error: '行动项不存在' }
    }
    updateActionItem(db, id, { status: 'adopted', decidedBy, decidedVia: via })
  }
  const updated = itemView(db, id)
  return updated ? { ok: true, item: updated } : { ok: false, status: 404, error: '行动项不存在' }
}

/** 删除行动项（外键级联清任务/反馈）；PRD API 声明补齐——UI 不设删除按钮，保护决策留痕。 */
export function removeActionItem(db: BoardDb, id: string): { ok: true } | { ok: false; status: number; error: string } {
  const deleted = deleteActionItem(db, id)
  return deleted ? { ok: true } : { ok: false, status: 404, error: `行动项不存在：${id}` }
}

// ---- G11：人工补充建议 ----

export interface ManualActionInput {
  projectId?: unknown
  title?: unknown
  rationale?: unknown
  scene?: unknown
  lifecycle?: unknown
  priority?: unknown
  effort?: unknown
  expectedImpact?: unknown
  reportId?: unknown
}

export type ManualActionOutcome =
  | { ok: true; item: ActionItemView }
  | { ok: false; status: number; error: string }

export function createManualAction(db: BoardDb, projectId: string, input: ManualActionInput): ManualActionOutcome {
  if (!getProject(db, projectId)) return { ok: false, status: 404, error: `项目不存在：${projectId}` }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : ''
  if (!title) return { ok: false, status: 400, error: '标题必填' }
  if (!rationale) return { ok: false, status: 400, error: '依据必填' }
  const scene = ACTION_SCENES.has(String(input.scene)) ? String(input.scene) : null
  const lifecycle = ACTION_LIFECYCLES.has(String(input.lifecycle)) ? String(input.lifecycle) : null
  const priority = ACTION_LEVELS.has(String(input.priority)) ? String(input.priority) : 'medium'
  const effort = ACTION_LEVELS.has(String(input.effort)) ? String(input.effort) : 'medium'
  const expectedImpact = typeof input.expectedImpact === 'string' && input.expectedImpact.trim() !== '' ? input.expectedImpact.trim() : '待评估'
  const reportId = typeof input.reportId === 'number' ? input.reportId : null
  const id = createActionItem(db, {
    projectId,
    sourceKind: 'manual',
    reportId,
    title,
    rationale,
    scene,
    lifecycle,
    expectedImpact,
    priority,
    effort,
    confidence: null,
    evidence: { facts: [], level: '经验假设', reasoning: rationale },
  })
  const item = itemView(db, id)
  return item ? { ok: true, item } : { ok: false, status: 500, error: '创建失败' }
}

// ---- 任务与反馈 ----

export interface TaskCreateInput {
  title?: unknown
  owner?: unknown
  dueDate?: unknown
  status?: unknown
  priority?: unknown
  note?: unknown
}

export type TaskOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

const TASK_STATUSES = new Set(['todo', 'doing', 'done'])

export function createTask(db: BoardDb, actionItemId: string, input: TaskCreateInput): TaskOutcome<ActionTaskView> {
  const item = getActionItem(db, actionItemId)
  if (!item) return { ok: false, status: 404, error: `行动项不存在：${actionItemId}` }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, status: 400, error: '任务标题必填' }
  const status = TASK_STATUSES.has(String(input.status)) ? (String(input.status) as ActionTaskStatus) : 'todo'
  const priority = ACTION_LEVELS.has(String(input.priority)) ? String(input.priority) : 'medium'
  const id = createActionTask(db, {
    actionItemId,
    title,
    owner: typeof input.owner === 'string' && input.owner.trim() !== '' ? input.owner.trim() : undefined,
    dueDate: typeof input.dueDate === 'string' && input.dueDate.trim() !== '' ? input.dueDate.trim() : undefined,
    status,
    priority,
    note: typeof input.note === 'string' ? input.note : '',
  })
  const task = getActionTask(db, id)
  const fb = getActionFeedback(db, id)
  return task
    ? { ok: true, data: { ...task, ...(fb ? { feedback: toFeedbackView(fb) } : {}) } }
    : { ok: false, status: 500, error: '创建失败' }
}

export interface TaskPatchInput extends TaskCreateInput {}

export function patchTask(db: BoardDb, taskId: string, input: TaskPatchInput): TaskOutcome<ActionTaskView> {
  const task = getActionTask(db, taskId)
  if (!task) return { ok: false, status: 404, error: `任务不存在：${taskId}` }
  const status = TASK_STATUSES.has(String(input.status)) ? (String(input.status) as ActionTaskStatus) : undefined
  const priority = ACTION_LEVELS.has(String(input.priority)) ? String(input.priority) : undefined
  updateActionTask(db, taskId, {
    ...(typeof input.title === 'string' && input.title.trim() !== '' ? { title: input.title.trim() } : {}),
    ...(typeof input.owner === 'string' ? { owner: input.owner.trim() || null } : {}),
    ...(typeof input.dueDate === 'string' ? { dueDate: input.dueDate.trim() || null } : {}),
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(typeof input.note === 'string' ? { note: input.note } : {}),
  })
  const updated = getActionTask(db, taskId)
  const fb = getActionFeedback(db, taskId)
  return updated
    ? { ok: true, data: { ...updated, ...(fb ? { feedback: toFeedbackView(fb) } : {}) } }
    : { ok: false, status: 500, error: '更新失败' }
}

export interface FeedbackInput {
  adopted?: unknown
  outcome?: unknown
  metricDelta?: unknown
  review?: unknown
  score?: unknown
}

function toFeedbackView(fb: ActionFeedbackRecord): ActionFeedbackView {
  return {
    adopted: fb.adopted,
    outcome: fb.outcome,
    metricDelta: fb.metricDelta,
    review: fb.review,
    score: fb.score,
    updatedAt: fb.updatedAt,
  }
}

export function saveFeedback(db: BoardDb, taskId: string, input: FeedbackInput): TaskOutcome<ActionFeedbackView> {
  const task = getActionTask(db, taskId)
  if (!task) return { ok: false, status: 404, error: `任务不存在：${taskId}` }
  const score = Number(input.score)
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return { ok: false, status: 400, error: 'score 必须是 1-5 整数（5=显著正向效果）' }
  }
  saveActionFeedback(db, taskId, {
    adopted: input.adopted === true,
    outcome: typeof input.outcome === 'string' ? input.outcome : '',
    metricDelta: typeof input.metricDelta === 'string' ? input.metricDelta : '',
    review: typeof input.review === 'string' ? input.review : '',
    score,
  })
  const fb = getActionFeedback(db, taskId)
  return fb ? { ok: true, data: toFeedbackView(fb) } : { ok: false, status: 500, error: '保存失败' }
}

export function readFeedback(db: BoardDb, taskId: string): TaskOutcome<ActionFeedbackView> {
  const task = getActionTask(db, taskId)
  if (!task) return { ok: false, status: 404, error: `任务不存在：${taskId}` }
  const fb = getActionFeedback(db, taskId)
  if (!fb) return { ok: false, status: 404, error: '该任务暂无反馈' }
  return { ok: true, data: toFeedbackView(fb) }
}
