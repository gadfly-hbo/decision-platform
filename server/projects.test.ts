import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { startServer } from './index'
import { closeBoardDb, createProject, insertExtractedActionItems, listProjects, openBoardDb, updateReportStatus, upsertReport } from './db'
import type { ActionItemDraft } from './agent/types'

let dir = ''
let dbPath = ''
let projectsDir = ''
let server: Server | null = null
let port = 0
let portSeq = 0
let base = ''

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
  dir = mkdtempSync(join(tmpdir(), 'dp-projects-'))
  dbPath = join(dir, 'board.db')
  projectsDir = join(dir, 'projects')
  mkdirSync(projectsDir, { recursive: true })
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server!.closeAllConnections?.()
      server!.close(() => resolve())
    })
    server = null
  }
  rmSync(dir, { recursive: true, force: true })
})

async function listen(): Promise<void> {
  port = 8640 + (portSeq++ % 20)
  server = startServer(port, '127.0.0.1', {
    dbPath,
    projectsDir,
    notifyFile: join(dir, 'notify.json'),
    notifyStateFile: join(dir, 'notify-state.json'),
  })
  await new Promise((resolve) => server!.on('listening', resolve))
  base = `http://127.0.0.1:${port}`
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init)
}

/** 直接在库文件上造数（项目+done 报告+n 条抽取项），再起服务复用同一库 */
function seedProject(title: string, itemTitles: string[] = ['提高复购频次']): string {
  const db = openBoardDb(dbPath)
  const project = createProject(db, { title })
  const report = upsertReport(db, project.id, { slug: '周报', filename: '周报.md' })
  updateReportStatus(db, report.id, 'done')
  insertExtractedActionItems(
    db,
    project.id,
    report.id,
    itemTitles.map((title) => ({ ...DRAFT, title })),
  )
  closeBoardDb(db)
  return project.id
}

/* ---- 旧库重建（M5 → M6 schema，用户决策：清空） ---- */

describe('schema 重建', () => {
  it('预置 M5 形态库文件（无 projects 表）→ openBoardDb 删文件重建：projects 表存在且全表为空', () => {
    // 手工构造 M5 形状库（不依赖已退役的 M5 代码）：四表无 project 维度 + 一行旧数据
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, imported_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE action_items (id TEXT PRIMARY KEY, report_id INTEGER REFERENCES reports(id) ON DELETE CASCADE, title TEXT NOT NULL);
      INSERT INTO reports (slug, filename, status, imported_at, updated_at) VALUES ('旧报告', '旧报告.md', 'done', 't', 't');
      INSERT INTO action_items (id, report_id, title) VALUES ('legacy-1', 1, '旧行动项');
    `)
    legacy.close()

    const db = openBoardDb(dbPath)
    expect(listProjects(db)).toEqual([]) // projects 表存在且空
    const counts = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
    expect(counts('reports')).toBe(0) // 旧数据随删库清空
    expect(counts('action_items')).toBe(0)
    closeBoardDb(db)
  })

  it('M6 库重复打开不重建（projects 保留）', () => {
    const db = openBoardDb(dbPath)
    const project = createProject(db, { title: '存量项目' })
    closeBoardDb(db)
    const again = openBoardDb(dbPath)
    expect(listProjects(again).map((p) => p.id)).toEqual([project.id])
    closeBoardDb(again)
  })
})

/* ---- 项目 CRUD / 硬删 / 统计 / board 隔离 / 旧端点移除 ---- */

describe('项目 API', () => {
  it('POST /api/projects：title 必填+trim、purpose 可选 → 201；缺 title/空串 400', async () => {
    await listen()
    const created = await api('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '  会员运营  ', purpose: '复购提升' }),
    })
    expect(created.status).toBe(201)
    const project = (await created.json()) as { id: string; title: string; purpose: string }
    expect(project.title).toBe('会员运营') // trim
    expect(project.purpose).toBe('复购提升')
    expect(project.id).toBeTruthy()

    const noTitle = await api('/api/projects', { method: 'POST', body: '{}' })
    expect(noTitle.status).toBe(400)
    const emptyTitle = await api('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    expect(emptyTitle.status).toBe(400)
  })

  it('GET /api/projects：含每项目行动项计数与 lastActivity', async () => {
    const idA = seedProject('项目A', ['建议一', '建议二'])
    const db = openBoardDb(dbPath)
    const projectB = createProject(db, { title: '项目B' })
    closeBoardDb(db)
    await listen()

    const res = await api('/api/projects')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{
        id: string
        title: string
        actionCounts: { suggested: number; adopted: number; dismissed: number; manual: number }
        lastActivity: string
      }>
    }
    const titles = body.projects.map((p) => p.title)
    expect(titles).toContain('项目A')
    expect(titles).toContain('项目B')
    const a = body.projects.find((p) => p.id === idA)!
    expect(a.actionCounts).toEqual({ suggested: 2, adopted: 0, dismissed: 0, manual: 0 })
    expect(a.lastActivity).toBeTruthy() // 项目内有报告/行动项更新
    const b = body.projects.find((p) => p.title === '项目B')!
    expect(b.actionCounts).toEqual({ suggested: 0, adopted: 0, dismissed: 0, manual: 0 })
    void projectB
  })

  it('PATCH /api/projects/:id：更新 title/purpose；不存在 404', async () => {
    const id = seedProject('旧名')
    await listen()
    const patched = await api(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新名', purpose: '新用途' }),
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { title: string }).title).toBe('新名')

    const missing = await api('/api/projects/no-such', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(missing.status).toBe(404)
  })

  it('DELETE /api/projects/:id：库级联（reports/items 清空）+ data/projects/<id>/ 目录硬删；目录缺失容忍；404 负向', async () => {
    const id = seedProject('待删项目')
    const projectDir = join(projectsDir, id)
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(projectDir, 'reports'), { recursive: true })

    await listen()
    const del = await api(`/api/projects/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true)

    const db = openBoardDb(dbPath)
    expect(listProjects(db)).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS c FROM reports').get() as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS c FROM action_items').get() as { c: number }).c).toBe(0)
    closeBoardDb(db)

    // 目录不存在时删除容忍（重复删 → 仍 200）
    const again = await api(`/api/projects/${id}`, { method: 'DELETE' })
    expect(again.status).toBe(404) // 项目已不在库中

    const missing = await api('/api/projects/no-such', { method: 'DELETE' })
    expect(missing.status).toBe(404)
  })

  it('GET /api/projects/:id/board：BoardView + project 元信息，数据限本项目（A 项目内容不出现在 B board）；404', async () => {
    const idA = seedProject('项目A', ['A-建议'])
    seedProject('项目B', ['B-建议'])
    await listen()

    const boardA = await api(`/api/projects/${idA}/board`)
    expect(boardA.status).toBe(200)
    const view = (await boardA.json()) as {
      project: { id: string; title: string; purpose: string }
      reports: Array<{ filename: string }>
      actionItems: Array<{ id: string; title: string; projectId: string }>
    }
    expect(view.project).toMatchObject({ id: idA, title: '项目A' })
    expect(view.actionItems).toHaveLength(1)
    expect(view.actionItems[0]).toMatchObject({ title: 'A-建议', projectId: idA })
    expect(view.reports[0].filename).toBe('周报.md')

    const missing = await api('/api/projects/no-such/board')
    expect(missing.status).toBe(404)
  })

  it('旧端点移除：/api/dashboard、全局 /api/reports、全局 /api/reports/extract → 404', async () => {
    await listen()
    expect((await api('/api/dashboard')).status).toBe(404)
    expect((await api('/api/reports')).status).toBe(404)
    expect((await api('/api/reports/extract', { method: 'POST', body: '{}' })).status).toBe(404)
  })
})
