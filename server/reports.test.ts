import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { startServer } from './index'
import { createReportPipeline } from './reports'
import { applyActionPatch } from './board'
import { createActionItem, listReports, updateReportStatus } from './db'
import type { ExtractionInput, ExtractionRunner } from './agent/extract'
import type { ActionItemDraft } from './agent/types'

let dir: string
let dataDir: string
let server: Server
let port: number

const DRAFT: ActionItemDraft = {
  title: '提高复购频次',
  rationale: '复购率下滑',
  expectedImpact: '复购率 +5%',
  priority: 'high',
  effort: 'low',
  confidence: 0.92,
  evidence: { facts: [{ text: '复购率下滑', quote: '复购率由 12% 降至 9%' }], level: '数据支撑', reasoning: '报告数据支持' },
}

function fakeRunner(result: ActionItemDraft[] = [DRAFT]): ExtractionRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async runExtraction(input) {
      calls.push(input.taskId)
      return result
    },
    async runExtractionRaw() {
      throw new Error('not used')
    },
  }
}

async function listen(runner: ExtractionRunner): Promise<void> {
  port = 8600 + Math.floor(Math.random() * 400)
  server = startServer(port, '127.0.0.1', {
    dataDir,
    dbPath: join(dir, 'board.db'),
    agentRunner: runner,
    notifyFile: join(dir, 'notify.json'),
    notifyStateFile: join(dir, 'notify-state.json'),
    pushScanIntervalMs: 60_000_000,
    pushScanFirstDelayMs: 60_000_000,
  })
  await new Promise((resolve) => server.on('listening', resolve))
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, init)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-pipe-'))
  dataDir = join(dir, 'raw')
  mkdirSync(dataDir)
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
  rmSync(dir, { recursive: true, force: true })
})

describe('报告扫描与抽取管线（SQLite + 假 runner）', () => {
  it('新 md/txt 报告注册为 pending；已注册 slug 不重复', async () => {
    writeFileSync(join(dataDir, '周报.md'), '# 报告一')
    await listen(fakeRunner())
    const reports1 = await (await api('/api/reports')).json()
    expect(reports1.reports).toHaveLength(1)
    expect(reports1.reports[0]).toMatchObject({ slug: '周报', filename: '周报.md', status: 'pending' })

    const reports2 = await (await api('/api/reports')).json()
    expect(reports2.reports).toHaveLength(1)
    expect(reports2.reports[0].id).toBe(reports1.reports[0].id)
  })

  it('extract 处理 pending 报告：done + 行动项入库；再次 extract 不重复处理', async () => {
    writeFileSync(join(dataDir, 'r1.md'), '报告内容')
    const runner = fakeRunner()
    await listen(runner)

    const extract1 = await api('/api/reports/extract', { method: 'POST', body: '{}' })
    expect(extract1.status).toBe(200)
    const body1 = await extract1.json()
    expect(body1.results).toHaveLength(1)
    expect(body1.results[0]).toMatchObject({ slug: 'r1', status: 'done', inserted: 1 })

    expect(runner.calls).toEqual(['extract:r1'])

    const extract2 = await api('/api/reports/extract', { method: 'POST', body: '{}' })
    const body2 = await extract2.json()
    expect(body2.results).toHaveLength(0) // 无待处理报告
    expect(runner.calls).toHaveLength(1)
  })

  it('runner 抛错 → failed + error 信息；可重试成功', async () => {
    writeFileSync(join(dataDir, 'r1.md'), '报告内容')
    let fail = true
    const runner: ExtractionRunner = {
      async runExtraction() {
        if (fail) throw new Error('模型超时')
        return []
      },
      async runExtractionRaw() {
        throw new Error('not used')
      },
    }
    await listen(runner)

    const extract1 = await api('/api/reports/extract', { method: 'POST', body: '{}' })
    const body1 = await extract1.json()
    expect(body1.results[0]).toMatchObject({ slug: 'r1', status: 'failed', error: '模型超时' })

    const reports = await (await api('/api/reports')).json()
    expect(reports.reports[0]).toMatchObject({ status: 'failed', error: '模型超时' })

    fail = false
    const extract2 = await api('/api/reports/extract', { method: 'POST', body: '{}' })
    const body2 = await extract2.json()
    expect(body2.results[0]).toMatchObject({ slug: 'r1', status: 'done' })
  })

  it('force 重抽（G3）：纯 suggested 删除重建；adopted/dismissed/含任务项存活', async () => {
    writeFileSync(join(dataDir, 'r1.md'), '报告内容')
    const draftOf = (title: string): ActionItemDraft => ({ ...DRAFT, title })
    let current: ActionItemDraft[] = [draftOf('A-已采纳'), draftOf('B-已驳回'), draftOf('C-含任务'), draftOf('D-纯建议')]
    const runner: ExtractionRunner = {
      async runExtraction() {
        return current
      },
      async runExtractionRaw() {
        throw new Error('not used')
      },
    }
    await listen(runner)
    await api('/api/reports/extract', { method: 'POST', body: '{}' })

    const board1 = (await (await api('/api/dashboard')).json()) as {
      actionItems: Array<{ id: string; title: string }>
    }
    const idOf = (title: string) => board1.actionItems.find((it) => it.title === title)?.id
    const idA = idOf('A-已采纳')
    const idB = idOf('B-已驳回')
    const idC = idOf('C-含任务')
    const idD = idOf('D-纯建议')
    expect([idA, idB, idC, idD].every(Boolean)).toBe(true)

    // 经 API 造数：A 采纳；B 驳回（带理由）；C 保持 suggested 但挂任务
    await api(`/api/actions/${idA}`, { method: 'PATCH', body: JSON.stringify({ status: 'adopted', via: 'board' }) })
    await api(`/api/actions/${idB}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'dismissed', dismissedReason: '与大盘趋势不符', via: 'board' }),
    })
    const task = await api(`/api/actions/${idC}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title: '联系渠道负责人', owner: '店长' }),
    })
    expect(task.status).toBe(200)

    // force 重抽：只返回一条新建议 → 纯 suggested（D）删除重建，其余存活
    current = [draftOf('E-新建议')]
    const force = await api('/api/reports/extract', {
      method: 'POST',
      body: JSON.stringify({ slug: 'r1', force: true }),
    })
    const forceBody = await force.json()
    expect(forceBody.results[0]).toMatchObject({ slug: 'r1', status: 'done', inserted: 1, removedStale: 1 })

    const board2 = (await (await api('/api/dashboard')).json()) as {
      actionItems: Array<{ id: string; title: string; tasks: unknown[] }>
    }
    const ids = new Set(board2.actionItems.map((it) => it.id))
    expect(ids.has(idA as string)).toBe(true) // adopted 存活
    expect(ids.has(idB as string)).toBe(true) // dismissed 存活
    expect(ids.has(idC as string)).toBe(true) // 含任务的 suggested 存活
    expect(ids.has(idD as string)).toBe(false) // 纯 suggested 被删除
    expect(board2.actionItems).toHaveLength(4) // A/B/C + 新 E
    const itemC = board2.actionItems.find((it) => it.id === idC)
    expect(itemC?.tasks).toHaveLength(1) // 存活项的任务未受影响
  })

  it('指定 slug 抽取单份报告；未知 slug 404', async () => {
    writeFileSync(join(dataDir, 'r1.md'), 'A')
    writeFileSync(join(dataDir, 'r2.txt'), 'B')
    await listen(fakeRunner())

    const only2 = await api('/api/reports/extract', { method: 'POST', body: JSON.stringify({ slug: 'r2' }) })
    const body = await only2.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].slug).toBe('r2')

    const missing = await api('/api/reports/extract', { method: 'POST', body: JSON.stringify({ slug: 'nope' }) })
    expect(missing.status).toBe(404)
  })

  it('旧 CSV 文件不被识别为报告', async () => {
    writeFileSync(join(dataDir, '会员周报4213-2026-09-26.csv'), 'a,b\n1,2')
    await listen(fakeRunner())
    const reports = await (await api('/api/reports')).json()
    expect(reports.reports).toHaveLength(0)
  })

  it('无 runner（模型不可用）→ 503 明确错误', async () => {
    writeFileSync(join(dataDir, 'r1.md'), 'A')
    port = 8600 + Math.floor(Math.random() * 400)
    server = startServer(port, '127.0.0.1', {
      dataDir,
      dbPath: join(dir, 'board.db'),
      notifyFile: join(dir, 'notify.json'),
      notifyStateFile: join(dir, 'notify-state.json'),
      pushScanIntervalMs: 60_000_000,
      pushScanFirstDelayMs: 60_000_000,
    })
    await new Promise((resolve) => server.on('listening', resolve))
    const res = await api('/api/reports/extract', { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain('模型')
  })
})

describe('G12 校准注入（抽取 prompt 注入驳回理由与人工补充方向）', () => {
  function seedItem(db: ReturnType<typeof createReportPipeline>['db'], title: string, priority = 'medium'): string {
    return createActionItem(db, {
      sourceKind: 'manual',
      reportId: null,
      title,
      rationale: `${title}的依据`,
      scene: null,
      lifecycle: null,
      expectedImpact: '待评估',
      priority,
      effort: 'medium',
      confidence: null,
      evidence: { facts: [], level: '经验假设', reasoning: `${title}的依据` },
    })
  }

  async function capturingRunner(drafts: ActionItemDraft[] = []): Promise<{ runner: ExtractionRunner; inputs: ExtractionInput[] }> {
    const inputs: ExtractionInput[] = []
    return {
      inputs,
      runner: {
        async runExtraction(input) {
          inputs.push(input)
          return drafts
        },
        async runExtractionRaw() {
          throw new Error('not used')
        },
      },
    }
  }

  it('有驳回（有内容的理由）与人工补充时 runner 收到 calibration；卡片默认占位理由无信号不注入', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dp-calib-'))
    try {
      const dataDir = join(work, 'raw')
      mkdirSync(dataDir)
      writeFileSync(join(dataDir, 'r1.md'), '报告内容')
      const pipeline = createReportPipeline(dataDir, join(work, 'board.db'))

      seedItem(pipeline.db, '上线会员日活动')
      const boardDismissed = seedItem(pipeline.db, '调整渠道预算')
      const cardDismissed = seedItem(pipeline.db, '更换门店物料')
      applyActionPatch(pipeline.db, boardDismissed, { status: 'dismissed', dismissedReason: '与大盘趋势不符', via: 'board' })
      applyActionPatch(pipeline.db, cardDismissed, { status: 'dismissed', via: 'card' }) // 默认占位理由

      const { runner, inputs } = await capturingRunner()
      await pipeline.extract(runner, {})
      expect(inputs[0].calibration).toEqual({
        dismissalReasons: ['与大盘趋势不符'],
        manualAdditions: [{ title: '上线会员日活动', rationale: '上线会员日活动的依据' }],
      })
      pipeline.close()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('无校准数据时 calibration 为 undefined（prompt 形态不变）', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dp-calib-empty-'))
    try {
      const dataDir = join(work, 'raw')
      mkdirSync(dataDir)
      writeFileSync(join(dataDir, 'r1.md'), '报告内容')
      const pipeline = createReportPipeline(dataDir, join(work, 'board.db'))

      const { runner, inputs } = await capturingRunner()
      await pipeline.extract(runner, {})
      expect(inputs[0].calibration).toBeUndefined()
      pipeline.close()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('扫描恢复（N4）：进程重启遗留 extracting 复位', () => {
  it('遗留 extracting 报告 → 扫描复位为 failed（可重试）；runner 就绪后重试成功', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dp-stuck-'))
    try {
      const rawDir = join(work, 'raw')
      mkdirSync(rawDir)
      writeFileSync(join(rawDir, 'r1.md'), '报告内容')
      const pipeline = createReportPipeline(rawDir, join(work, 'board.db'))
      const registered = pipeline.listReports()[0]
      updateReportStatus(pipeline.db, registered.id, 'extracting') // 模拟进程崩溃遗留（本进程无在抽任务）
      expect(listReports(pipeline.db)[0].status).toBe('extracting') // 原始读取（不经扫描）确认遗留态

      const afterScan = pipeline.listReports() // listReports = scanReports（含复位）
      expect(afterScan[0]).toMatchObject({ status: 'failed', error: '进程重启中断抽取，可重试' })

      const okRunner: ExtractionRunner = {
        async runExtraction() {
          return []
        },
        async runExtractionRaw() {
          throw new Error('not used')
        },
      }
      const results = await pipeline.extract(okRunner, {}) // failed 可重试
      expect(results[0]).toMatchObject({ slug: 'r1', status: 'done' })
      pipeline.close()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
