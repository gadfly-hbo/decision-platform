import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { startServer } from './index'
import { closeBoardDb, createProject, insertExtractedActionItems, openBoardDb, updateReportStatus, upsertReport } from './db'
import type { ActionItemDraft } from './agent/types'

let dir: string
let dbPath: string
let projectId: string
let server: Server
let portSeq = 0
let port: number
let base: string

const DRAFT: ActionItemDraft = {
  title: '提高复购频次',
  rationale: '复购率下滑',
  expectedImpact: '复购率 +5%',
  priority: 'high',
  effort: 'low',
  confidence: 0.92,
  evidence: { facts: [{ text: '复购率下滑', quote: '复购率由 12% 降至 9%' }], level: '数据支撑', reasoning: '报告数据支持' },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-board-'))
  dbPath = join(dir, 'board.db')
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
  rmSync(dir, { recursive: true, force: true })
})

/** M6：直接在库文件造数（项目 + done 报告 + 抽取项），再起服务复用同一库（全局抽取端点已移除）；
 *  itemTitles 为空 = 仅建项目（无报告无行动项，isDemo 用例）。 */
async function listen(itemTitles: string[] = [DRAFT.title]): Promise<void> {
  const db = openBoardDb(dbPath)
  const project = createProject(db, { title: '测试项目' })
  projectId = project.id
  if (itemTitles.length > 0) {
    const report = upsertReport(db, project.id, { slug: 'r1', filename: 'r1.md' })
    updateReportStatus(db, report.id, 'done')
    insertExtractedActionItems(db, project.id, report.id, itemTitles.map((title) => ({ ...DRAFT, title })))
  }
  closeBoardDb(db)

  port = 8600 + (portSeq++ % 40)
  server = startServer(port, '127.0.0.1', {
    dbPath,
    projectsDir: join(dir, 'projects'),
    notifyFile: join(dir, 'notify.json'),
    notifyStateFile: join(dir, 'notify-state.json'),
  })
  await new Promise((resolve) => server.on('listening', resolve))
  base = `http://127.0.0.1:${port}`
}

async function firstItemId(): Promise<string> {
  const board = await (await fetch(`${base}/api/projects/${projectId}/board`)).json()
  return board.actionItems[0].id
}

interface ActionItemView {
  id: string
  status: string
  dismissedReason: string | null
  decidedBy: string | null
  decidedVia: string | null
  tasks: Array<{ id: string; status: string }>
}

async function board(): Promise<{
  reports: unknown[]
  actionItems: ActionItemView[]
  stats: Record<string, number>
  isDemo: boolean
  notify: { configured: boolean }
  modelChain: { available: boolean }
}> {
  return (await (await fetch(`${base}/api/projects/${projectId}/board`)).json()) as never
}

async function patchAction(id: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/actions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/projects/:id/board（M6 项目 board 聚合）', () => {
  it('聚合项目元信息、报告、行动项（含任务/反馈嵌套）、统计、通知与模型链状态', async () => {
    await listen()
    const view = await board()
    expect(view.reports).toHaveLength(1)
    expect(view.actionItems).toHaveLength(1)
    expect(view.actionItems[0]).toMatchObject({ status: 'suggested', title: '提高复购频次' })
    expect(view.actionItems[0].tasks).toEqual([])
    expect(view.stats).toMatchObject({ suggested: 1, adopted: 0, dismissed: 0, manual: 0 })
    expect(view.isDemo).toBe(false)
    expect(view.notify).toMatchObject({ configured: false })
    expect(typeof view.modelChain.available).toBe('boolean')
  })

  it('项目内无报告无行动项时 isDemo=true', async () => {
    await listen([])
    const view = await board()
    expect(view.isDemo).toBe(true)
    expect(view.actionItems).toEqual([])
  })
})

describe('PATCH /api/actions/:id（G10 确认与驳回理由）', () => {
  it('看板驳回：缺理由 400；理由 <2 字 400；合规驳回落库留痕', async () => {
    await listen()
    const id = await firstItemId()

    const noReason = await patchAction(id, { status: 'dismissed', via: 'board' })
    expect(noReason.status).toBe(400)
    const shortReason = await patchAction(id, { status: 'dismissed', dismissedReason: '差', via: 'board' })
    expect(shortReason.status).toBe(400)

    const ok = await patchAction(id, { status: 'dismissed', dismissedReason: '与大盘趋势不符', via: 'board', decidedBy: '老板' })
    expect(ok.status).toBe(200)
    const item = (await ok.json()) as ActionItemView
    expect(item).toMatchObject({
      status: 'dismissed',
      dismissedReason: '与大盘趋势不符',
      decidedBy: '老板',
      decidedVia: 'board',
    })
  })

  it('卡片驳回：默认理由落库，看板可补填覆盖一次', async () => {
    await listen()
    const id = await firstItemId()

    const card = await patchAction(id, { status: 'dismissed', via: 'card', decidedBy: '审批人' })
    const cardItem = (await card.json()) as ActionItemView
    expect(cardItem.dismissedReason).toBe('卡片驳回（未填理由）')

    // 看板渠道已填理由只读：直接 dismissedReason 覆盖被拒绝（非补填语义）
    const overwrite = await patchAction(id, { dismissedReason: '硬改' })
    expect(overwrite.status).toBe(400)

    // 补填：仅卡片默认值可补填
    const backfill = await patchAction(id, { backfillDismissedReason: '复购数据与大盘一致，建议不成立' })
    expect(backfill.status).toBe(200)
    const filled = (await backfill.json()) as ActionItemView
    expect(filled.dismissedReason).toBe('复购数据与大盘一致，建议不成立')
  })

  it('正常采纳留痕；改判驳回（adopted→dismissed）需理由；不存在 id 404', async () => {
    await listen()
    const id = await firstItemId()

    const adopt = await patchAction(id, { status: 'adopted', via: 'board', decidedBy: '老板' })
    expect(adopt.status).toBe(200)
    expect(((await adopt.json()) as ActionItemView).decidedVia).toBe('board')

    const flipNoReason = await patchAction(id, { status: 'dismissed', via: 'board' })
    expect(flipNoReason.status).toBe(400)
    const flip = await patchAction(id, { status: 'dismissed', dismissedReason: '情况变化撤销', via: 'board' })
    expect(flip.status).toBe(200)

    const missing = await patchAction('no-such-id', { status: 'adopted', via: 'board' })
    expect(missing.status).toBe(404)
  })

  it('重复驳回幂等：已 dismissed 再驳回同理由返回当前态', async () => {
    await listen()
    const id = await firstItemId()
    await patchAction(id, { status: 'dismissed', dismissedReason: '第一次理由', via: 'board' })
    const again = await patchAction(id, { status: 'dismissed', dismissedReason: '第一次理由', via: 'board' })
    expect(again.status).toBe(200)
    expect(((await again.json()) as ActionItemView).dismissedReason).toBe('第一次理由')
  })

  it('已驳回项换理由再驳回 → 400 不可改写（N2：理由是沉淀的决策资产，补填是唯一入口）', async () => {
    await listen()
    const id = await firstItemId()
    await patchAction(id, { status: 'dismissed', dismissedReason: '第一次理由', via: 'board' })

    const overwrite = await patchAction(id, { status: 'dismissed', dismissedReason: '换一个理由', via: 'board' })
    expect(overwrite.status).toBe(400)
    expect(((await overwrite.json()) as { error: string }).error).toContain('驳回理由不可改写')

    const cardOverwrite = await patchAction(id, { status: 'dismissed', dismissedReason: '卡片渠道硬改', via: 'card' })
    expect(cardOverwrite.status).toBe(400) // 卡片渠道同拒

    const view = await board()
    expect(view.actionItems[0].dismissedReason).toBe('第一次理由') // 原理由未被改写
  })
})

describe('POST /api/actions（G11 人工补充建议）', () => {
  it('必填校验 + 证据固定经验假设 + 归组人工', async () => {
    await listen([]) // 仅项目（无抽取项），人工项为唯一 suggested
    const noTitle = await fetch(`${base}/api/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, rationale: '有依据无标题' }),
    })
    expect(noTitle.status).toBe(400)

    const ok = await fetch(`${base}/api/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: '上线会员日活动', rationale: '一线观察到周末客流高', priority: 'medium' }),
    })
    expect(ok.status).toBe(200)
    const item = (await ok.json()) as ActionItemView & { sourceKind: string; evidenceLevel: string; confidence: number | null }
    expect(item.sourceKind).toBe('manual')
    expect(item.status).toBe('suggested')
    expect(item.evidenceLevel).toBe('经验假设')
    expect(item.confidence).toBeNull()

    const view = await board()
    expect(view.stats.manual).toBe(1)
    expect(view.stats.suggested).toBe(1)
  })
})

describe('任务与反馈', () => {
  it('任务 CRUD 三态与反馈一任务一条（覆盖语义）', async () => {
    await listen()
    const itemId = await firstItemId()

    const createTask = await fetch(`${base}/api/actions/${itemId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '联系渠道负责人', owner: '店长', dueDate: '2026-10-20' }),
    })
    expect(createTask.status).toBe(200)
    const task = (await createTask.json()) as { id: string; status: string; owner: string | null }
    expect(task.status).toBe('todo')

    const patchTask = await fetch(`${base}/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'doing' }),
    })
    expect(((await patchTask.json()) as { status: string }).status).toBe('doing')

    // 反馈：非法 score 400；合法落库；重复 POST 覆盖
    const badScore = await fetch(`${base}/api/tasks/${task.id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adopted: true, outcome: 'x', score: 9 }),
    })
    expect(badScore.status).toBe(400)

    const fb1 = await fetch(`${base}/api/tasks/${task.id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adopted: true, outcome: '已执行', metricDelta: '+3%', review: '有效', score: 4 }),
    })
    expect(fb1.status).toBe(200)

    const fb2 = await fetch(`${base}/api/tasks/${task.id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adopted: true, outcome: '补充复盘', metricDelta: '', review: '二次复盘', score: 5 }),
    })
    expect(fb2.status).toBe(200)

    const got = await (await fetch(`${base}/api/tasks/${task.id}/feedback`)).json()
    expect(got).toMatchObject({ review: '二次复盘', score: 5 })

    // dashboard 聚合里任务带反馈
    const view = await board()
    const aggregated = view.actionItems[0].tasks[0] as { id: string; feedback?: { score: number } }
    expect(aggregated.id).toBe(task.id)
    expect(aggregated.feedback).toMatchObject({ score: 5 })

    // 负向：任务挂不存在的行动项 404
    const orphan = await fetch(`${base}/api/actions/no-such/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(orphan.status).toBe(404)
  })
})

describe('DELETE /api/actions/:id（B3：PRD/契约声明的 API 补齐；不设 UI 按钮）', () => {
  it('删除后 dashboard 消失，任务/反馈外键级联清理；不存在 id 404', async () => {
    await listen()
    const id = await firstItemId()

    // 采纳 → 挂任务 → 回录反馈，验证级联清理
    await patchAction(id, { status: 'adopted', via: 'board' })
    const taskRes = await fetch(`${base}/api/actions/${encodeURIComponent(id)}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '联系渠道负责人' }),
    })
    expect(taskRes.status).toBe(200)
    const task = (await taskRes.json()) as { id: string }
    const fbRes = await fetch(`${base}/api/tasks/${encodeURIComponent(task.id)}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adopted: true, outcome: '已执行', score: 4 }),
    })
    expect(fbRes.status).toBe(200)

    const del = await fetch(`${base}/api/actions/${encodeURIComponent(id)}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true)

    const view = await board()
    expect(view.actionItems.map((it) => it.id)).not.toContain(id)
    expect(view.stats).toMatchObject({ suggested: 0, adopted: 0, dismissed: 0 })
    // 任务随外键级联删除：其反馈端点 404（任务不存在）
    const fb = await fetch(`${base}/api/tasks/${encodeURIComponent(task.id)}/feedback`)
    expect(fb.status).toBe(404)

    const missing = await fetch(`${base}/api/actions/no-such-id`, { method: 'DELETE' })
    expect(missing.status).toBe(404)
  })
})
