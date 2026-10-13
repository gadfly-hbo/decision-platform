import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ActionEvidence, ActionItemDraft } from './agent/types'
import type {
  ActionFeedbackRecord,
  ActionItemRecord,
  ActionItemStatus,
  ActionTaskRecord,
  ActionTaskStatus,
  ProjectRecord,
  ReportRecord,
  ReportStatus,
} from '../src/data/types'

/**
 * 行动闭环存储（M6 项目化）：node:sqlite 单文件库。
 * projects 为根容器（uuid），reports/action_items 直挂 project_id（外键级联）；tasks/feedback 经级联不变。
 * schema 迁移策略 = 清空重建（用户决策）：打开时无 projects 表的 M5 旧库直接删文件重建。
 */

export type { ActionFeedbackRecord, ActionItemRecord, ActionItemStatus, ActionTaskRecord, ActionTaskStatus, ProjectRecord, ReportRecord, ReportStatus } from '../src/data/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  report_id INTEGER REFERENCES reports(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL DEFAULT 'extracted',
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  scene TEXT,
  lifecycle TEXT,
  expected_impact TEXT NOT NULL,
  metric_ref TEXT,
  priority TEXT NOT NULL,
  effort TEXT NOT NULL,
  confidence REAL,
  evidence_json TEXT,
  evidence_level TEXT,
  status TEXT NOT NULL DEFAULT 'suggested',
  dismissed_reason TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decided_via TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS action_tasks (
  id TEXT PRIMARY KEY,
  action_item_id TEXT NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  owner TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS action_feedback (
  task_id TEXT PRIMARY KEY REFERENCES action_tasks(id) ON DELETE CASCADE,
  adopted INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  metric_delta TEXT NOT NULL DEFAULT '',
  review TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_project ON reports(project_id);
CREATE INDEX IF NOT EXISTS idx_action_items_project ON action_items(project_id);
CREATE INDEX IF NOT EXISTS idx_action_items_report ON action_items(report_id);
CREATE INDEX IF NOT EXISTS idx_action_tasks_item ON action_tasks(action_item_id);
`

export type BoardDb = DatabaseSync

/** M5 旧库检测：文件已存在但无 projects 表 → 删文件（含 -wal/-shm）后重建（清空起步，用户决策）。 */
export function openBoardDb(path: string): BoardDb {
  if (existsSync(path)) {
    const probe = new DatabaseSync(path)
    let hasProjectsTable = false
    try {
      const row = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()
      hasProjectsTable = row !== undefined
    } finally {
      probe.close()
    }
    if (!hasProjectsTable) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(`${path}${suffix}`, { force: true })
        } catch {
          // 删除失败由后续打开报错兜底
        }
      }
    }
  }
  mkdirSync(dirname(path), { recursive: true }) // 父目录不存在时创建（如全新部署的 data/）
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

export function closeBoardDb(db: BoardDb): void {
  db.close()
}

const now = (): string => new Date().toISOString()

// ---- projects ----

export function createProject(db: BoardDb, input: { title: string; purpose?: string }): ProjectRecord {
  const id = randomUUID()
  const at = now()
  db.prepare('INSERT INTO projects (id, title, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    input.title,
    input.purpose ?? '',
    at,
    at,
  )
  return { id, title: input.title, purpose: input.purpose ?? '', createdAt: at, updatedAt: at }
}

export function getProject(db: BoardDb, id: string): ProjectRecord | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined
  return row ? parseProject(row) : null
}

export function listProjects(db: BoardDb): ProjectRecord[] {
  // updated_at 倒序 = 最近活跃在前（推送缺省项目、前端列表共用口径）
  return (db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC').all() as unknown as ProjectRow[]).map(parseProject)
}

export function updateProject(db: BoardDb, id: string, patch: { title?: string; purpose?: string }): ProjectRecord | null {
  const current = getProject(db, id)
  if (!current) return null
  db.prepare('UPDATE projects SET title = ?, purpose = ?, updated_at = ? WHERE id = ?').run(
    patch.title ?? current.title,
    patch.purpose ?? current.purpose,
    now(),
    id,
  )
  return getProject(db, id)
}

/** 硬删项目：reports/action_items/tasks/feedback 由外键级联清理；报告目录由调用方删。 */
export function deleteProject(db: BoardDb, id: string): boolean {
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  return Number(result.changes) > 0
}

/** 项目列表聚合：行动项四态计数 + 项目内最新 updated_at（reports/items/projects 取最大）。 */
export function projectActionCounts(db: BoardDb, projectId: string): { suggested: number; adopted: number; dismissed: number; manual: number } {
  const rows = db
    .prepare("SELECT status, source_kind FROM action_items WHERE project_id = ?")
    .all(projectId) as Array<{ status: string; source_kind: string }>
  return {
    suggested: rows.filter((r) => r.status === 'suggested').length,
    adopted: rows.filter((r) => r.status === 'adopted').length,
    dismissed: rows.filter((r) => r.status === 'dismissed').length,
    manual: rows.filter((r) => r.source_kind === 'manual').length,
  }
}

export function projectLastActivity(db: BoardDb, projectId: string): string {
  const row = db
    .prepare(
      `SELECT MAX(m) AS last FROM (
         SELECT updated_at AS m FROM projects WHERE id = ?
         UNION ALL SELECT updated_at FROM reports WHERE project_id = ?
         UNION ALL SELECT updated_at FROM action_items WHERE project_id = ?
       )`,
    )
    .get(projectId, projectId, projectId) as { last: string | null }
  return row.last ?? ''
}

// ---- reports（项目维度）----

export function upsertReport(db: BoardDb, projectId: string, input: { slug: string; filename: string }): ReportRecord {
  const existing = db
    .prepare('SELECT * FROM reports WHERE project_id = ? AND slug = ?')
    .get(projectId, input.slug) as unknown as ReportRow | undefined
  if (existing) return parseReport(existing)
  const at = now()
  db.prepare('INSERT INTO reports (project_id, slug, filename, status, imported_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    projectId,
    input.slug,
    input.filename,
    'pending',
    at,
    at,
  )
  return parseReport(
    db.prepare('SELECT * FROM reports WHERE project_id = ? AND slug = ?').get(projectId, input.slug) as unknown as ReportRow,
  )
}

export function listReports(db: BoardDb, projectId?: string): ReportRecord[] {
  const rows = projectId
    ? (db.prepare('SELECT * FROM reports WHERE project_id = ? ORDER BY imported_at DESC, id DESC').all(projectId) as unknown as ReportRow[])
    : (db.prepare('SELECT * FROM reports ORDER BY imported_at DESC, id DESC').all() as unknown as ReportRow[])
  return rows.map(parseReport)
}

export function getReportBySlug(db: BoardDb, projectId: string, slug: string): ReportRecord | null {
  const row = db
    .prepare('SELECT * FROM reports WHERE project_id = ? AND slug = ?')
    .get(projectId, slug) as unknown as ReportRow | undefined
  return row ? parseReport(row) : null
}

export function updateReportStatus(db: BoardDb, id: number, status: ReportStatus, error?: string): void {
  db.prepare('UPDATE reports SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(
    status,
    error ?? null,
    now(),
    id,
  )
}

// ---- action_items ----

export function insertExtractedActionItems(db: BoardDb, projectId: string, reportId: number, drafts: ActionItemDraft[]): string[] {
  const insert = db.prepare(`
    INSERT INTO action_items (id, project_id, report_id, source_kind, title, rationale, scene, lifecycle, expected_impact, metric_ref, priority, effort, confidence, evidence_json, evidence_level, status, created_at, updated_at)
    VALUES (?, ?, ?, 'extracted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?, ?)
  `)
  const ids: string[] = []
  const at = now()
  for (const draft of drafts) {
    const id = randomUUID()
    insert.run(
      id,
      projectId,
      reportId,
      draft.title,
      draft.rationale,
      draft.scene ?? null,
      draft.lifecycle ?? null,
      draft.expectedImpact,
      draft.metricRef ?? null,
      draft.priority,
      draft.effort,
      draft.confidence,
      draft.evidence ? JSON.stringify(draft.evidence) : null,
      draft.evidence?.level ?? null,
      at,
      at,
    )
    ids.push(id)
  }
  return ids
}

export interface CreateManualActionInput {
  projectId: string
  sourceKind: 'extracted' | 'manual'
  reportId: number | null
  title: string
  rationale: string
  scene?: string | null
  lifecycle?: string | null
  expectedImpact: string
  priority: string
  effort: string
  confidence: number | null
  evidence: ActionEvidence
}

export function createActionItem(db: BoardDb, input: CreateManualActionInput): string {
  const id = randomUUID()
  const at = now()
  db.prepare(`
    INSERT INTO action_items (id, project_id, report_id, source_kind, title, rationale, scene, lifecycle, expected_impact, priority, effort, confidence, evidence_json, evidence_level, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?, ?)
  `).run(
    id,
    input.projectId,
    input.reportId,
    input.sourceKind,
    input.title,
    input.rationale,
    input.scene ?? null,
    input.lifecycle ?? null,
    input.expectedImpact,
    input.priority,
    input.effort,
    input.confidence,
    JSON.stringify(input.evidence),
    input.evidence.level,
    at,
    at,
  )
  return id
}

export interface UpdateActionItemPatch {
  status?: ActionItemStatus
  dismissedReason?: string
  decidedBy?: string
  decidedVia?: string
}

export function updateActionItem(db: BoardDb, id: string, patch: UpdateActionItemPatch): void {
  const current = getActionItem(db, id)
  if (!current) throw new Error(`行动项不存在：${id}`)
  db.prepare(
    'UPDATE action_items SET status = ?, dismissed_reason = ?, decided_by = ?, decided_at = ?, decided_via = ?, updated_at = ? WHERE id = ?',
  ).run(
    patch.status ?? current.status,
    patch.dismissedReason ?? current.dismissedReason,
    patch.decidedBy ?? current.decidedBy,
    patch.decidedBy || patch.status ? now() : current.decidedAt,
    patch.decidedVia ?? current.decidedVia,
    now(),
    id,
  )
}

/** G3：force 重抽前清理仍为 suggested 且无任务的抽取项；返回清理条数。 */
export function deleteStaleSuggested(db: BoardDb, reportId: number): number {
  const rows = db
    .prepare(
      `SELECT id FROM action_items
       WHERE report_id = ? AND source_kind = 'extracted' AND status = 'suggested'
         AND id NOT IN (SELECT action_item_id FROM action_tasks)`,
    )
    .all(reportId) as Array<{ id: string }>
  const del = db.prepare('DELETE FROM action_items WHERE id = ?')
  for (const row of rows) del.run(row.id)
  return rows.length
}

/** 删除行动项（外键级联清任务/反馈）；返回是否存在。API 语义见 board.removeActionItem，UI 不设删除按钮。 */
export function deleteActionItem(db: BoardDb, id: string): boolean {
  const result = db.prepare('DELETE FROM action_items WHERE id = ?').run(id)
  return Number(result.changes) > 0
}

export function getActionItem(db: BoardDb, id: string): ActionItemRecord | null {
  const row = db.prepare('SELECT * FROM action_items WHERE id = ?').get(id) as unknown as ActionItemRow | undefined
  return row ? parseActionItem(row) : null
}

export function listActionItems(db: BoardDb, filter: { projectId?: string } = {}): ActionItemRecord[] {
  const rows = filter.projectId
    ? (db.prepare('SELECT * FROM action_items WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(filter.projectId) as unknown as ActionItemRow[])
    : (db.prepare('SELECT * FROM action_items ORDER BY created_at DESC, id DESC').all() as unknown as ActionItemRow[])
  return rows.map(parseActionItem)
}

// ---- action_tasks ----

export interface CreateActionTaskInput {
  actionItemId: string
  title: string
  owner?: string
  dueDate?: string
  status?: ActionTaskStatus
  priority?: string
  note?: string
}

export function createActionTask(db: BoardDb, input: CreateActionTaskInput): string {
  const item = getActionItem(db, input.actionItemId)
  if (!item) throw new Error(`行动项不存在：${input.actionItemId}`)
  const id = randomUUID()
  const at = now()
  db.prepare(`
    INSERT INTO action_tasks (id, action_item_id, title, owner, due_date, status, priority, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.actionItemId,
    input.title,
    input.owner ?? null,
    input.dueDate ?? null,
    input.status ?? 'todo',
    input.priority ?? 'medium',
    input.note ?? '',
    at,
    at,
  )
  return id
}

/** 批量挂任务（导入/回放用）；返回新任务 id 列表。 */
export function upsertActionItemTasks(
  db: BoardDb,
  actionItemId: string,
  tasks: Array<{ title: string; owner?: string; dueDate?: string; status?: ActionTaskStatus; priority?: string; note?: string }>,
): string[] {
  return tasks.map((task) =>
    createActionTask(db, {
      actionItemId,
      title: task.title,
      owner: task.owner,
      dueDate: task.dueDate,
      status: task.status,
      priority: task.priority,
      note: task.note,
    }),
  )
}

export function listTasksOfItem(db: BoardDb, actionItemId: string): ActionTaskRecord[] {
  return (
    db.prepare('SELECT * FROM action_tasks WHERE action_item_id = ? ORDER BY created_at, id').all(actionItemId) as unknown as ActionTaskRow[]
  ).map(parseActionTask)
}

export function listAllTasks(db: BoardDb): ActionTaskRecord[] {
  return (db.prepare('SELECT * FROM action_tasks ORDER BY created_at, id').all() as unknown as ActionTaskRow[]).map(parseActionTask)
}

export function getActionTask(db: BoardDb, id: string): ActionTaskRecord | null {
  const row = db.prepare('SELECT * FROM action_tasks WHERE id = ?').get(id) as unknown as ActionTaskRow | undefined
  return row ? parseActionTask(row) : null
}

export interface UpdateActionTaskPatch {
  title?: string
  owner?: string | null
  dueDate?: string | null
  status?: ActionTaskStatus
  priority?: string
  note?: string
}

export function updateActionTask(db: BoardDb, id: string, patch: UpdateActionTaskPatch): void {
  const current = getActionTask(db, id)
  if (!current) throw new Error(`任务不存在：${id}`)
  db.prepare(
    'UPDATE action_tasks SET title = ?, owner = ?, due_date = ?, status = ?, priority = ?, note = ?, updated_at = ? WHERE id = ?',
  ).run(
    patch.title ?? current.title,
    patch.owner !== undefined ? patch.owner : current.owner,
    patch.dueDate !== undefined ? patch.dueDate : current.dueDate,
    patch.status ?? current.status,
    patch.priority ?? current.priority,
    patch.note ?? current.note,
    now(),
    id,
  )
}

export function hasTasks(db: BoardDb, actionItemId: string): boolean {
  const row = db.prepare('SELECT 1 FROM action_tasks WHERE action_item_id = ? LIMIT 1').get(actionItemId)
  return row !== undefined
}

// ---- action_feedback ----

export interface ActionFeedbackInput {
  adopted: boolean
  outcome: string
  metricDelta: string
  review: string
  score: number
}

/** 一任务一条：存在则整体覆盖（最新复盘为准），历史以更新时间留痕。 */
export function saveActionFeedback(db: BoardDb, taskId: string, input: ActionFeedbackInput): void {
  const task = getActionTask(db, taskId)
  if (!task) throw new Error(`任务不存在：${taskId}`)
  const at = now()
  db.prepare(`
    INSERT INTO action_feedback (task_id, adopted, outcome, metric_delta, review, score, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET adopted = excluded.adopted, outcome = excluded.outcome,
      metric_delta = excluded.metric_delta, review = excluded.review, score = excluded.score, updated_at = excluded.updated_at
  `).run(taskId, input.adopted ? 1 : 0, input.outcome, input.metricDelta, input.review, input.score, at, at)
}

export function getActionFeedback(db: BoardDb, taskId: string): ActionFeedbackRecord | null {
  const row = db.prepare('SELECT * FROM action_feedback WHERE task_id = ?').get(taskId) as unknown as ActionFeedbackRow | undefined
  return row ? parseActionFeedback(row) : null
}

export function listAllFeedback(db: BoardDb): ActionFeedbackRecord[] {
  return (db.prepare('SELECT * FROM action_feedback ORDER BY updated_at DESC').all() as unknown as ActionFeedbackRow[]).map(
    parseActionFeedback,
  )
}

// ---- 行映射 ----

interface ProjectRow {
  id: string
  title: string
  purpose: string
  created_at: string
  updated_at: string
}

function parseProject(row: ProjectRow): ProjectRecord {
  return { id: row.id, title: row.title, purpose: row.purpose, createdAt: row.created_at, updatedAt: row.updated_at }
}

interface ReportRow {
  id: number
  project_id: string
  slug: string
  filename: string
  status: string
  error: string | null
  imported_at: string
  updated_at: string
}

function parseReport(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    filename: row.filename,
    status: row.status as ReportStatus,
    error: row.error,
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  }
}

interface ActionItemRow {
  id: string
  project_id: string
  report_id: number | null
  source_kind: string
  title: string
  rationale: string
  scene: string | null
  lifecycle: string | null
  expected_impact: string
  metric_ref: string | null
  priority: string
  effort: string
  confidence: number | null
  evidence_json: string | null
  evidence_level: string | null
  status: string
  dismissed_reason: string | null
  decided_by: string | null
  decided_at: string | null
  decided_via: string | null
  created_at: string
  updated_at: string
}

function parseActionItem(row: ActionItemRow): ActionItemRecord {
  let evidence: ActionEvidence | null = null
  if (row.evidence_json) {
    try {
      evidence = JSON.parse(row.evidence_json) as ActionEvidence
    } catch {
      evidence = null // 损坏降级为无证据，不阻塞展示
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    reportId: row.report_id,
    sourceKind: row.source_kind as 'extracted' | 'manual',
    title: row.title,
    rationale: row.rationale,
    scene: row.scene,
    lifecycle: row.lifecycle,
    expectedImpact: row.expected_impact,
    metricRef: row.metric_ref,
    priority: row.priority,
    effort: row.effort,
    confidence: row.confidence,
    evidence,
    evidenceLevel: row.evidence_level,
    status: row.status as ActionItemStatus,
    dismissedReason: row.dismissed_reason,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decidedVia: row.decided_via,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface ActionTaskRow {
  id: string
  action_item_id: string
  title: string
  owner: string | null
  due_date: string | null
  status: string
  priority: string
  note: string
  created_at: string
  updated_at: string
}

function parseActionTask(row: ActionTaskRow): ActionTaskRecord {
  return {
    id: row.id,
    actionItemId: row.action_item_id,
    title: row.title,
    owner: row.owner,
    dueDate: row.due_date,
    status: row.status as ActionTaskStatus,
    priority: row.priority,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface ActionFeedbackRow {
  task_id: string
  adopted: number
  outcome: string
  metric_delta: string
  review: string
  score: number
  created_at: string
  updated_at: string
}

function parseActionFeedback(row: ActionFeedbackRow): ActionFeedbackRecord {
  return {
    taskId: row.task_id,
    adopted: row.adopted === 1,
    outcome: row.outcome,
    metricDelta: row.metric_delta,
    review: row.review,
    score: row.score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
