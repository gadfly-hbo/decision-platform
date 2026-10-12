import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeBoardDb,
  createActionItem,
  createActionTask,
  getActionFeedback,
  insertExtractedActionItems,
  listActionItems,
  listReports,
  openBoardDb,
  saveActionFeedback,
  upsertReport,
  updateActionItem,
  updateReportStatus,
  upsertActionItemTasks,
  listTasksOfItem,
  getActionItem,
} from './db'
import type { ActionItemDraft } from './agent/types'

let dir: string
let db: ReturnType<typeof openBoardDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-db-'))
  db = openBoardDb(join(dir, 'board.db'))
})

afterEach(() => {
  closeBoardDb(db)
  rmSync(dir, { recursive: true, force: true })
})

const DRAFT: ActionItemDraft = {
  title: '提高复购频次',
  rationale: '复购率下滑',
  scene: '日常',
  lifecycle: 'R复购',
  expectedImpact: '复购率 +5%',
  priority: 'high',
  effort: 'low',
  confidence: 0.92,
  evidence: {
    facts: [{ text: '复购率下滑', quote: '复购率由 12% 降至 9%' }],
    level: '数据支撑',
    reasoning: '报告数据直接支持',
  },
}

describe('reports 表', () => {
  it('upsert 按 slug 幂等：同文件不重复注册，imported_at 保持首次', () => {
    const first = upsertReport(db, { slug: 'a-report', filename: 'A Report.md' })
    const second = upsertReport(db, { slug: 'a-report', filename: 'A Report.md' })
    expect(second.id).toBe(first.id)
    expect(listReports(db)).toHaveLength(1)
  })

  it('状态迁移与错误信息落库', () => {
    const r = upsertReport(db, { slug: 'r1', filename: 'r1.md' })
    updateReportStatus(db, r.id, 'extracting')
    updateReportStatus(db, r.id, 'failed', '模型超时')
    const failed = listReports(db).find((x) => x.id === r.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('模型超时')
  })
})

describe('action_items 表', () => {
  it('抽取项整批插入，evidence 往返无损', () => {
    const r = upsertReport(db, { slug: 'r1', filename: 'r1.md' })
    const ids = insertExtractedActionItems(db, r.id, [DRAFT])
    expect(ids).toHaveLength(1)
    const item = getActionItem(db, ids[0])
    expect(item).toMatchObject({
      reportId: r.id,
      sourceKind: 'extracted',
      status: 'suggested',
      confidence: 0.92,
      evidenceLevel: '数据支撑',
    })
    expect(item?.evidence?.facts[0].quote).toBe('复购率由 12% 降至 9%')
  })

  it('人工项：report_id 可空、source_kind=manual、证据固定经验假设', () => {
    const id = createActionItem(db, {
      sourceKind: 'manual',
      reportId: null,
      title: '人工建议',
      rationale: '一线经验',
      expectedImpact: '待评估',
      priority: 'medium',
      effort: 'medium',
      confidence: null,
      evidence: { facts: [], level: '经验假设', reasoning: '一线经验' },
    })
    const item = getActionItem(db, id)
    expect(item?.sourceKind).toBe('manual')
    expect(item?.reportId).toBeNull()
    expect(item?.evidenceLevel).toBe('经验假设')
    expect(item?.confidence).toBeNull()
  })

  it('状态迁移与驳回理由、审批留痕', () => {
    const r = upsertReport(db, { slug: 'r1', filename: 'r1.md' })
    const [id] = insertExtractedActionItems(db, r.id, [DRAFT])
    updateActionItem(db, id, {
      status: 'dismissed',
      dismissedReason: '与大盘趋势不符',
      decidedBy: '审批人',
      decidedVia: 'board',
    })
    const item = getActionItem(db, id)
    expect(item).toMatchObject({
      status: 'dismissed',
      dismissedReason: '与大盘趋势不符',
      decidedBy: '审批人',
      decidedVia: 'board',
    })
    expect(item?.decidedAt).toBeTruthy()
  })

  it('列表支持按报告过滤与人工项并列', () => {
    const r = upsertReport(db, { slug: 'r1', filename: 'r1.md' })
    insertExtractedActionItems(db, r.id, [DRAFT])
    createActionItem(db, { sourceKind: 'manual', reportId: null, title: '人工', rationale: 'x', expectedImpact: 'y', priority: 'low', effort: 'low', confidence: null, evidence: { facts: [], level: '经验假设', reasoning: 'x' } })
    expect(listActionItems(db)).toHaveLength(2)
    expect(listActionItems(db, { reportId: r.id })).toHaveLength(1)
  })
})

describe('action_tasks / action_feedback 表', () => {
  it('任务挂行动项、级联删除随行动项（force 重抽语义的基础）', () => {
    const [itemId] = insertExtractedActionItems(db, upsertReport(db, { slug: 'r1', filename: 'r1.md' }).id, [DRAFT])
    const taskId = createActionTask(db, { actionItemId: itemId, title: '联系渠道负责人' })
    upsertActionItemTasks(db, itemId, [{ title: '调整话术', owner: '店长', status: 'todo', priority: 'high', note: '' }])
    expect(listTasksOfItem(db, itemId)).toHaveLength(2)

    saveActionFeedback(db, taskId, { adopted: true, outcome: '已执行', metricDelta: '复购率 +3%', review: '有效', score: 4 })
    expect(getActionFeedback(db, taskId)).toMatchObject({ adopted: true, score: 4, metricDelta: '复购率 +3%' })

    // 一任务一条：重复保存覆盖
    saveActionFeedback(db, taskId, { adopted: true, outcome: '补充复盘', metricDelta: '', review: '二次', score: 5 })
    expect(getActionFeedback(db, taskId)?.review).toBe('二次')
  })
})
