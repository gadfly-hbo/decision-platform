import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Server } from 'node:http'
import { startServer } from './index'
import { closeBoardDb, createProject, openBoardDb } from './db'
import type { ActionItemDraft } from './agent/types'
import type { ExtractionRunner as Runner } from './agent/extract'

let dir = ''
let dbPath = ''
let projectsDir = ''
let server: Server | null = null
let port = 0
let portSeq = 0
let base = ''
let projectId = ''

const DRAFT: ActionItemDraft = {
  title: '对沉睡会员发放阶梯券',
  rationale: '复购率下滑',
  expectedImpact: '复购率 +2pp',
  priority: 'high',
  effort: 'medium',
  confidence: 0.92,
  evidence: { facts: [{ text: '复购率下滑', quote: '会员复购率由 12% 降至 9%' }], level: '数据支撑', reasoning: 'r' },
}

/** 可变假 runner：默认返回 1 条高优数据级行动项 */
function fakeRunner(): Runner & { setDrafts: (drafts: ActionItemDraft[]) => void; calls: string[] } {
  let drafts: ActionItemDraft[] = [DRAFT]
  const calls: string[] = []
  return {
    calls,
    setDrafts: (next) => {
      drafts = next
    },
    async runExtraction(input) {
      calls.push(input.taskId)
      return drafts
    },
  }
}

function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-upload-'))
  dbPath = join(dir, 'board.db')
  projectsDir = join(dir, 'projects')
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

async function listen(runner: Runner | null = fakeRunner(), extra: Record<string, unknown> = {}): Promise<string> {
  const db = openBoardDb(dbPath)
  const project = createProject(db, { title: '上传项目', purpose: 'M6-T2' })
  projectId = project.id
  closeBoardDb(db)
  port = 8660 + (portSeq++ % 40)
  server = startServer(port, '127.0.0.1', {
    dbPath,
    projectsDir,
    notifyFile: join(dir, 'notify.json'),
    notifyStateFile: join(dir, 'notify-state.json'),
    ...(runner ? { agentRunner: runner } : {}),
    ...extra,
  })
  await new Promise((resolve) => server!.on('listening', resolve))
  base = `http://127.0.0.1:${port}`
  return projectId
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init)
}

async function upload(body: unknown): Promise<Response> {
  return api(`/api/projects/${projectId}/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function reportsDirOf(id = projectId): string {
  return join(projectsDir, id, 'reports')
}

/** 轮询项目 board 直到谓词命中（异步抽取不阻塞上传响应） */
async function waitBoard(predicate: (board: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const start = Date.now()
  for (;;) {
    const board = (await (await api(`/api/projects/${projectId}/board`)).json()) as Record<string, unknown>
    if (predicate(board)) return board
    if (Date.now() - start > timeoutMs) throw new Error('等待 board 状态超时')
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
}

interface UploadResult {
  filename?: string
  slug?: string
  ok: boolean
  status: string
  error?: string
}

describe('上传负向校验（逐份失败不连锁）', () => {
  it('项目 404', async () => {
    await listen()
    const res = await fetch(`${base}/api/projects/no-such/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ filename: 'a.md', contentBase64: b64('A') }] }),
    })
    expect(res.status).toBe(404)
  })

  it('非 md/txt、空文件名、路径分隔符、坏 base64、>2MB、二进制 U+FFFD 逐份拒绝', async () => {
    await listen()
    const big = 'x'.repeat(2 * 1024 * 1024 + 1)
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x82]).toString('base64')
    const res = await upload({
      files: [
        { filename: '周报.pdf', contentBase64: b64('PDF') },
        { filename: '', contentBase64: b64('x') },
        { filename: '../evil.md', contentBase64: b64('穿越') },
        { filename: 'bad.md', contentBase64: '!!!not-base64!!!' },
        { filename: 'big.md', contentBase64: b64(big) },
        { filename: 'binary.md', contentBase64: binary },
      ],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: UploadResult[] }
    expect(body.results).toHaveLength(6)
    for (const result of body.results) {
      expect(result.ok).toBe(false)
      expect(result.status).toBe('failed')
      expect(result.error).toBeTruthy()
    }
    expect(body.results.find((r) => r.filename === '周报.pdf')?.error).toContain('.md/.txt')
    expect(body.results.find((r) => r.filename === 'big.md')?.error).toContain('2MB')
    expect(body.results.find((r) => r.filename === 'binary.md')?.error).toContain('UTF-8')
    expect(existsSync(reportsDirOf())).toBe(false) // 全拒时不落盘不注册
  })

  it('缺文件字段 400', async () => {
    await listen()
    const empty = await upload({ files: [] })
    expect(empty.status).toBe(400)
    const noFields = await upload({ foo: 1 })
    expect(noFields.status).toBe(400)
  })
})

describe('上传与异步抽取', () => {
  it('多文件（含一个失败）逐份结果；合法文件落盘+pending+异步抽取 done + 行动项入库', async () => {
    const runner = fakeRunner()
    await listen(runner)
    const res = await upload({
      files: [
        { filename: '周报A.md', contentBase64: b64('# 周报A\n会员复购率由 12% 降至 9%。') },
        { filename: '周报B.txt', contentBase64: b64('周报B 正文') },
        { filename: '周报C.csv', contentBase64: b64('a,b') },
      ],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: UploadResult[] }
    expect(body.results).toHaveLength(3)
    const okResults = body.results.filter((r) => r.ok)
    expect(okResults.map((r) => r.filename).sort()).toEqual(['周报A.md', '周报B.txt'])
    expect(body.results.find((r) => r.filename === '周报C.csv')?.ok).toBe(false) // 单败不连锁

    // 落盘 + 注册 + 异步抽取完成
    expect(readFileSync(join(reportsDirOf(), '周报A.md'), 'utf-8')).toContain('周报A')
    const board = (await waitBoard((b) => (b.reports as Array<{ status: string }>).filter((r) => r.status === 'done').length === 2)) as {
      reports: Array<{ slug: string; status: string }>
      actionItems: Array<{ title: string; projectId: string }>
    }
    expect(board.reports.map((r) => r.slug).sort()).toEqual(['周报A', '周报B'])
    expect(board.actionItems).toHaveLength(2) // 每报告 1 条高优建议
    expect(board.actionItems.every((item) => item.projectId === projectId)).toBe(true)
    expect(runner.calls).toHaveLength(2)
  })

  it('无 runner → 上传成功但报告 failed「模型不可用」（与 M5 语义一致）', async () => {
    await listen(null)
    const res = await upload({ filename: '周报.md', contentBase64: b64('正文') }) // 单文件形态兼容
    expect(res.status).toBe(200)
    expect(((await res.json()) as { results: UploadResult[] }).results[0]).toMatchObject({ ok: true, status: 'accepted' })
    const board = (await waitBoard((b) => (b.reports as Array<{ status: string }>).every((r) => r.status === 'failed'))) as {
      reports: Array<{ status: string; error: string | null }>
    }
    expect(board.reports[0].error).toContain('模型不可用')
  })

  it('同名覆盖 = force 重抽（G3 保护已决项）：纯 suggested 删除重建，adopted/dismissed/含任务存活', async () => {
    const draftOf = (title: string): ActionItemDraft => ({ ...DRAFT, title })
    const runner = fakeRunner()
    await listen(runner)
    // 首传：4 条建议
    runner.setDrafts([draftOf('A-已采纳'), draftOf('B-已驳回'), draftOf('C-含任务'), draftOf('D-纯建议')])
    await upload({ filename: '周报.md', contentBase64: b64('第一版') })
    const first = (await waitBoard((b) => (b.actionItems as unknown[]).length === 4)) as {
      actionItems: Array<{ id: string; title: string }>
    }
    const idOf = (title: string) => first.actionItems.find((it) => it.title === title)?.id
    const idA = idOf('A-已采纳') as string
    const idB = idOf('B-已驳回') as string
    const idC = idOf('C-含任务') as string
    const idD = idOf('D-纯建议') as string

    // 造数：A 采纳 / B 驳回 / C 挂任务
    await api(`/api/actions/${idA}`, { method: 'PATCH', body: JSON.stringify({ status: 'adopted', via: 'board' }) })
    await api(`/api/actions/${idB}`, { method: 'PATCH', body: JSON.stringify({ status: 'dismissed', dismissedReason: '不成立', via: 'board' }) })
    await api(`/api/actions/${idC}/tasks`, { method: 'POST', body: JSON.stringify({ title: '联系负责人' }) })

    // 同名再传（内容更新）：曾 done → pending + force 重抽（新建议 1 条）
    runner.setDrafts([draftOf('E-新建议')])
    const again = await upload({ filename: '周报.md', contentBase64: b64('第二版') })
    expect(((await again.json()) as { results: UploadResult[] }).results[0].ok).toBe(true)
    expect(readFileSync(join(reportsDirOf(), '周报.md'), 'utf-8')).toBe('第二版') // 文件覆盖

    const second = (await waitBoard((b) => (b.actionItems as unknown[]).length === 4)) as {
      actionItems: Array<{ id: string; title: string; tasks: unknown[] }>
    }
    const ids = new Set(second.actionItems.map((it) => it.id))
    expect(ids.has(idA)).toBe(true)
    expect(ids.has(idB)).toBe(true)
    expect(ids.has(idC)).toBe(true)
    expect(ids.has(idD)).toBe(false) // 纯 suggested 删除重建
    expect(second.actionItems.find((it) => it.id === idC)?.tasks).toHaveLength(1)
  })
})

describe('项目抽取端点', () => {
  it('项目 404；无 runner 503；无待处理 200 空结果；slug+force 语义可用', async () => {
    const runner = fakeRunner()
    await listen(runner)
    const missing = await fetch(`${base}/api/projects/no-such/reports/extract`, { method: 'POST', body: '{}' })
    expect(missing.status).toBe(404)

    // 无待处理（项目内尚无报告）
    const idle = await api(`/api/projects/${projectId}/reports/extract`, { method: 'POST', body: '{}' })
    expect(idle.status).toBe(200)
    expect(((await idle.json()) as { results: unknown[] }).results).toEqual([])

    // 上传后手动 force 重抽同一 slug
    await upload({ filename: '周报.md', contentBase64: b64('v1') })
    await waitBoard((b) => (b.reports as Array<{ status: string }>)[0]?.status === 'done')
    const force = await api(`/api/projects/${projectId}/reports/extract`, {
      method: 'POST',
      body: JSON.stringify({ slug: '周报', force: true }),
    })
    expect(force.status).toBe(200)
    expect(((await force.json()) as { results: Array<{ status: string; removedStale?: number }> }).results[0]).toMatchObject({
      status: 'done',
      removedStale: 1, // 旧 suggested 清理重建
    })
  })

  it('无 runner → 503 明确错误', async () => {
    await listen(null)
    const res = await api(`/api/projects/${projectId}/reports/extract`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('模型不可用')
  })
})

describe('抽取完成事件驱动推送', () => {
  it('上传抽取 done 后自动推送一次（摘要含【项目名】+高优卡片）；force 重抽不重复推（幂等）；手动重推真发且带项目名', async () => {
    const runner = fakeRunner()
    const sent: Array<{ digest: string; cards: unknown[] }> = []
    const imChannel = {
      sendApproval: vi.fn(async (digest: string, cards: unknown[]) => {
        sent.push({ digest, cards })
      }),
    }
    await listen(runner, { imChannel })
    await upload({ filename: '周报.md', contentBase64: b64('正文') })
    await waitBoard((b) => (b.reports as Array<{ status: string }>)[0]?.status === 'done')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].digest).toContain('【上传项目】') // 摘要带项目名（PRD 推送节）
    expect(sent[0].digest).toContain('行动闭环周摘要')
    expect(sent[0].cards).toHaveLength(1) // 高优+数据支撑建议成卡
    expect((sent[0].cards[0] as { itemId: string }).itemId).toBeTruthy()

    // force 重抽（有新行动项）→ 已推过同 slug：不重复自动推
    await api(`/api/projects/${projectId}/reports/extract`, { method: 'POST', body: JSON.stringify({ slug: '周报', force: true }) })
    await waitBoard((b) => (b.reports as Array<{ updatedAt: string }>)[0]?.updatedAt !== '')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(sent).toHaveLength(1)

    // 手动重推 = 补救语义：真发一轮且摘要带项目名
    const push = await api('/api/notify/push', { method: 'POST', body: '{}' })
    expect(push.status).toBe(200)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1].digest).toContain('【上传项目】')
  })

  it('0 行动项报告不自动推（inserted>0 门）：通道就绪 + runner 返回空数组 → done 但 sent 为空', async () => {
    const runner = fakeRunner()
    runner.setDrafts([]) // 抽取成功但 0 条行动项（合法结果）
    const sent: Array<{ digest: string; cards: unknown[] }> = []
    const imChannel = {
      sendApproval: vi.fn(async (digest: string, cards: unknown[]) => {
        sent.push({ digest, cards })
      }),
    }
    await listen(runner, { imChannel })
    const res = await upload({ filename: '空报告.md', contentBase64: b64('无行动项') })
    expect(((await res.json()) as { results: UploadResult[] }).results[0].ok).toBe(true)
    await waitBoard((b) => (b.reports as Array<{ status: string }>)[0]?.status === 'done') // 抽取完成
    await new Promise((resolve) => setTimeout(resolve, 300)) // 给事件驱动推送留窗口
    expect(sent).toHaveLength(0) // inserted=0 → 不推（不占用审批人注意力）
  })
})

describe('同名上传 force 无条件化（评审修复 1）', () => {
  it('v1 done → force 重抽失败（报告 failed、v1 suggested 残留）→ 同名再传 v3 → 无条件 force：v1 残留清干净，仅 v3 的 suggested', async () => {
    const runner = fakeRunner()
    await listen(runner)
    // v1：1 条 suggested，抽取成功
    await upload({ filename: '周报.md', contentBase64: b64('v1') })
    await waitBoard((b) => (b.reports as Array<{ status: string }>)[0]?.status === 'done')
    let board = (await (await api(`/api/projects/${projectId}/board`)).json()) as {
      actionItems: Array<{ id: string; title: string }>
    }
    expect(board.actionItems).toHaveLength(1)

    // v2 同名上传 → force 重抽，但 runner 抛错 → 报告 failed（deleteStaleSuggested 在抽取成功后才清理，失败不清数据）
    let fail = true
    const originalRun = runner.runExtraction.bind(runner)
    ;(runner as unknown as { runExtraction: typeof originalRun }).runExtraction = async (input) => {
      if (fail) throw new Error('模型超时')
      return originalRun(input)
    }
    await upload({ filename: '周报.md', contentBase64: b64('v2') })
    await waitBoard((b) => (b.reports as Array<{ status: string }>)[0]?.status === 'failed')
    // 中间断言：失败重试期间 v1 的 suggested 保留（清理只在成功后发生）
    const failedBoard = (await (await api(`/api/projects/${projectId}/board`)).json()) as {
      actionItems: Array<{ title: string }>
    }
    expect(failedBoard.actionItems).toHaveLength(1)

    // v3 同名再传（报告处于 failed，非 done）→ 无条件 force：成功时清理 v1 残留 + 插入 v3
    fail = false
    runner.setDrafts([{ ...DRAFT, title: 'v3-新建议' }])
    const v3 = await upload({ filename: '周报.md', contentBase64: b64('v3') })
    expect(((await v3.json()) as { results: UploadResult[] }).results[0].ok).toBe(true)
    board = (await waitBoard(
      (b) => (b.actionItems as Array<{ title: string }>).some((it) => it.title === 'v3-新建议'),
    )) as typeof board
    const finalBoard = (await (await api(`/api/projects/${projectId}/board`)).json()) as { reports: Array<{ status: string }> }
    expect(finalBoard.reports[0].status).toBe('done')
    expect(board.actionItems.map((it) => it.title)).toEqual(['v3-新建议']) // 无 v1/v2 残留
  })
})

describe('extracting 自愈（评审修复 2：board 加载路径触发复位）', () => {
  it('预置 extracting 报告（非本进程在抽）→ GET board → 报告变 failed 可重试', async () => {
    const runner = fakeRunner()
    await listen(runner)
    await upload({ filename: '周报.md', contentBase64: b64('v1') })
    await waitBoard((b) => (b.reports as Array<{ status: string }>)[0]?.status === 'done')

    // 直接改库模拟进程崩溃遗留 extracting（绕过 inFlight 守卫——非 extractReports 路径设置）
    const db = openBoardDb(dbPath)
    const report = db.prepare('SELECT id FROM reports WHERE project_id = ?').get(projectId) as { id: number }
    db.prepare("UPDATE reports SET status = 'extracting' WHERE id = ?").run(report.id)
    closeBoardDb(db)

    // GET board（旧实现只 listReports 不扫描 → extracting 永久卡死；修复后 board 加载触发 scanReports 复位）
    const board = (await (await api(`/api/projects/${projectId}/board`)).json()) as {
      reports: Array<{ status: string; error: string | null }>
    }
    expect(board.reports[0]).toMatchObject({ status: 'failed', error: '进程重启中断抽取，可重试' })

    // failed 可重试：再上传同名 → 抽取恢复正常
    await upload({ filename: '周报.md', contentBase64: b64('v2') })
    const healed = (await waitBoard((b) => (b.reports as Array<{ status: string }>)[0]?.status === 'done')) as {
      reports: Array<{ status: string }>
    }
    expect(healed.reports[0].status).toBe('done')
  })
})
