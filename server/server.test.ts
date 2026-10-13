import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Server } from 'node:http'
import { startServer, type ServerOptions } from './index'
import { closeBoardDb, createProject, insertExtractedActionItems, openBoardDb, updateReportStatus, upsertReport } from './db'
import type { ActionItemDraft } from './agent/types'

const DRAFT: ActionItemDraft = {
  title: '对沉睡会员发放阶梯券',
  rationale: '复购率下滑',
  expectedImpact: '复购率 +2pp',
  priority: 'high',
  effort: 'medium',
  confidence: 0.92,
  evidence: { facts: [{ text: '复购率下滑', quote: '会员复购率由 12% 降至 9%' }], level: '数据支撑', reasoning: 'r' },
}

/** 在指定库文件上造数：项目 + done 报告 + 1 条高优数据级抽取项（sealDone=false 时报告保持 pending） */
function seedProjectBoard(dbPath: string, options: { sealDone?: boolean; reportSlug?: string } = {}): string {
  const db = openBoardDb(dbPath)
  const project = createProject(db, { title: '推送项目' })
  const report = upsertReport(db, project.id, { slug: options.reportSlug ?? '会员周报-2026-09-26', filename: `${options.reportSlug ?? '会员周报-2026-09-26'}.md` })
  if (options.sealDone !== false) {
    updateReportStatus(db, report.id, 'done')
    insertExtractedActionItems(db, project.id, report.id, [DRAFT])
  }
  closeBoardDb(db)
  return project.id
}

async function withServer<T>(
  fn: (base: string) => Promise<T>,
  extra: ServerOptions = {},
): Promise<T> {
  const server: Server = startServer(0, '127.0.0.1', { ...extra })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  try {
    return await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('GET /api/health 返回 ok 与服务名', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('decision-platform-server')
  })
})

test('未知路径返回 404 JSON', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not found')
  })
})

/* ---- 推送端点（项目作用域）---- */

test('POST /api/notify/*：未配置 400；项目就绪后手动推送真发一轮并落 projectId:slug（webhook 降级四态）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dp-notify-'))
  const notifyFile = join(work, 'notify.json')
  const stateFile = join(work, 'notify-state.json')
  const dbPath = join(work, 'board.db')
  try {
    await withServer(async (base) => {
      const noCfg = await fetch(`${base}/api/notify/test`, { method: 'POST' })
      expect(noCfg.status).toBe(400)
      const noCfgPush = await fetch(`${base}/api/notify/push`, { method: 'POST' })
      expect(noCfgPush.status).toBe(400)
    }, { notifyFile, notifyStateFile: stateFile, dbPath })

    writeFileSync(notifyFile, JSON.stringify({ platform: 'feishu', url: 'https://hook.example/t' }), 'utf-8')
    // 劫持外部 webhook；本机 server 请求走真 fetch
    const realFetch = globalThis.fetch.bind(globalThis)
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('http://127.0.0.1')) return realFetch(url as string, init)
      return { ok: true } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const projectId = seedProjectBoard(dbPath)
    await withServer(async (base) => {
      const test = await fetch(`${base}/api/notify/test`, { method: 'POST' })
      expect(test.status).toBe(200)
      const webhookCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://'))
      expect(webhookCalls()).toHaveLength(1)

      // 四态：webhook 已配置未推送 → imConfigured=false、无 lastPushedReport
      const board0 = (await (await fetch(`${base}/api/projects/${projectId}/board`)).json()) as { notify: Record<string, unknown> }
      expect(board0.notify).toMatchObject({ configured: true, imConfigured: false })
      expect(board0.notify.lastPushedReport).toBeUndefined()

      // 手动推送（缺省取最近活跃项目 + 其最新 done 报告）
      const push1 = await fetch(`${base}/api/notify/push`, { method: 'POST' })
      expect(push1.status).toBe(200)
      const body1 = (await push1.json()) as { pushed: boolean; projectId: string; period: string }
      expect(body1).toEqual({ pushed: true, projectId, period: '会员周报-2026-09-26' })
      const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
      expect(url).toBe('https://hook.example/t')
      expect((init.body as string)).toContain('行动闭环周摘要')
      // 手动重推 = 补救语义：真发一轮（body 可带 projectId/slug 定向）
      const push2 = await fetch(`${base}/api/notify/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, slug: '会员周报-2026-09-26' }),
      })
      expect(((await push2.json()) as { pushed: boolean }).pushed).toBe(true)
      // test 推送 1 次 + 手动重推 2 次 = 3 次 webhook
      expect(webhookCalls()).toHaveLength(3)

      // 幂等键 projectId:slug → board lastPushedReport 呈现 slug 段
      const board1 = (await (await fetch(`${base}/api/projects/${projectId}/board`)).json()) as { notify: Record<string, unknown> }
      expect(board1.notify).toMatchObject({ configured: true, imConfigured: false, lastPushedReport: '会员周报-2026-09-26' })

      // 负向：不存在项目 404；报告未抽取完成 400
      const noProject = await fetch(`${base}/api/notify/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'no-such' }),
      })
      expect(noProject.status).toBe(404)
    }, { notifyFile, notifyStateFile: stateFile, dbPath })
    vi.unstubAllGlobals()
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('手动重推走 IM 通道（文本+高优卡片，按报告过滤）；webhook 文本不挡道；board 四态含 imConfigured', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dp-notify-im-'))
  const notifyFile = join(work, 'notify.json')
  const stateFile = join(work, 'notify-state.json')
  const dbPath = join(work, 'board.db')
  writeFileSync(notifyFile, JSON.stringify({ platform: 'feishu', url: 'https://hook.example/f' }), 'utf-8')
  const realFetch = globalThis.fetch.bind(globalThis)
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url as string, init)
    return { ok: true } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    const projectId = seedProjectBoard(dbPath)
    const sent: Array<{ digest: string; cards: unknown[] }> = []
    const imChannel = {
      sendApproval: vi.fn(async (digest: string, cards: unknown[]) => {
        sent.push({ digest, cards })
      }),
    }
    await withServer(async (base) => {
      const board0 = (await (await fetch(`${base}/api/projects/${projectId}/board`)).json()) as { notify: Record<string, unknown> }
      expect(board0.notify).toMatchObject({ configured: true, imConfigured: true })
      expect(board0.notify.lastPushedReport).toBeUndefined()

      const push = await fetch(`${base}/api/notify/push`, { method: 'POST' })
      expect(push.status).toBe(200)
      expect(((await push.json()) as { projectId: string; period: string })).toMatchObject({ projectId, period: '会员周报-2026-09-26' })
      expect(sent).toHaveLength(1)
      expect(sent[0].digest).toContain('建议 1')
      expect(sent[0].cards).toHaveLength(1) // 高优+数据支撑建议成卡，按报告过滤
      expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://'))).toHaveLength(0) // 不走群机器人

      const board1 = (await (await fetch(`${base}/api/projects/${projectId}/board`)).json()) as { notify: Record<string, unknown> }
      expect(board1.notify).toMatchObject({ configured: true, imConfigured: true, lastPushedReport: '会员周报-2026-09-26' })
    }, { notifyFile, notifyStateFile: stateFile, dbPath, imChannel })
  } finally {
    vi.unstubAllGlobals()
    rmSync(work, { recursive: true, force: true })
  }
})

test('推送负向：项目内无 done 报告 → 400；库内无项目 → 404', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dp-notify-neg-'))
  try {
    const notifyFile = join(work, 'notify.json')
    const dbPath = join(work, 'board.db')
    writeFileSync(notifyFile, JSON.stringify({ platform: 'generic', url: 'https://hook.example/n' }), 'utf-8')

    // 库内无项目
    await withServer(async (base) => {
      const noProject = await fetch(`${base}/api/notify/push`, { method: 'POST' })
      expect(noProject.status).toBe(404)
    }, { notifyFile, notifyStateFile: join(work, 'state.json'), dbPath })

    // 项目有报告但未抽取完成
    const projectId = seedProjectBoard(dbPath, { sealDone: false })
    await withServer(async (base) => {
      const noDone = await fetch(`${base}/api/notify/push`, { method: 'POST' })
      expect(noDone.status).toBe(400)
      void projectId
    }, { notifyFile, notifyStateFile: join(work, 'state.json'), dbPath })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

/* ---- REVIEW cycle 1：路由兜底 ---- */

test('畸形行动项 id（decodeURIComponent 失败）→ 400 且进程存活', async () => {
  await withServer(async (base) => {
    const patch = await fetch(`${base}/api/actions/%`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(patch.status).toBe(400)
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
  })
})

test('畸形 request-target（GET //）→ 400 且进程存活（cycle 3 BLOCKER 回归）', async () => {
  const { connect } = await import('node:net')
  await withServer(async (base) => {
    const address = new URL(base)
    const statusLine = await new Promise<string>((resolve, reject) => {
      const sock = connect({ host: address.hostname, port: Number(address.port) }, () => {
        sock.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
      })
      sock.on('data', (chunk) => {
        resolve(chunk.toString().split('\r\n')[0])
        sock.destroy()
      })
      sock.on('error', reject)
    })
    expect(statusLine).toContain('400')
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
  })
})

/* ---- 静态文件服务（dist 生产模式）---- */

function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'dp-dist-'))
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>决策看板</title>', 'utf-8')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)', 'utf-8')
  return dist
}

test('GET / 服务 index.html；未知路由 SPA fallback；静态资源按类型直出；/api 优先', async () => {
  const dist = makeDist()
  try {
    await withServer(async (base) => {
      const root = await fetch(`${base}/`)
      expect(root.status).toBe(200)
      expect(root.headers.get('content-type')).toContain('text/html')
      expect(await root.text()).toContain('决策看板')

      const spa = await fetch(`${base}/some/deep/route`)
      expect(spa.status).toBe(200)
      expect(await spa.text()).toContain('决策看板')

      const asset = await fetch(`${base}/assets/app.js`)
      expect(asset.status).toBe(200)
      expect(await asset.text()).toBe('console.log(1)')

      const nope = await fetch(`${base}/api/nope`)
      expect(nope.status).toBe(404)
      expect(await nope.json()).toEqual({ error: 'not found' })
    }, { distDir: dist })
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('dist 目录不存在 → 非 API GET 404，行为与现状一致', async () => {
  const missing = join(tmpdir(), `dp-no-dist-${Date.now()}`)
  await withServer(async (base) => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('not found')
  }, { distDir: missing })
})

test('路径穿越尝试不出 dist（回退 index.html，不泄漏源码）', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'dp-dist-sec-'))
  writeFileSync(join(dist, 'index.html'), '<html>ok</html>', 'utf-8')
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/%2e%2e/server/index.ts`)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('<html>ok</html>')
      expect(body).not.toContain('startServer')
    }, { distDir: dist })
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

/* ---- M5 T7：账本/审计投影端点（S-R 运行详情数据源；全局账本不随项目化拆分）---- */

test('GET /api/agent/usage：未注入 → available:false；注入假账本 → 快照与路径回显', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agent/usage`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false })
  })
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agent/usage`)
    expect(await res.json()).toMatchObject({
      available: true,
      totals: { modelCalls: 2, inputTokens: 120, outputTokens: 80, activeMs: 1500, toolCalls: 1, resourceUnits: 3 },
      ledgerPath: '/tmp/dp-fake-ledger.json',
      auditPath: '/tmp/dp-fake-audit.jsonl',
    })
  }, {
    agentLedger: {
      usageTotals: () => ({ modelCalls: 2, inputTokens: 120, outputTokens: 80, activeMs: 1500, toolCalls: 1, resourceUnits: 3 }),
      usageOf: () => null,
      ledgerPath: '/tmp/dp-fake-ledger.json',
    },
    agentAuditPath: '/tmp/dp-fake-audit.jsonl',
  })
})

test('GET /api/agent/events：审计尾部 ≤100 行投影（M6 taskId 含项目段）；非抽取任务过滤；文件缺失 → 空', async () => {
  const auditDir = mkdtempSync(join(tmpdir(), 'dp-agent-events-'))
  const auditPath = join(auditDir, 'agent-audit.jsonl')
  const lines: string[] = [
    // 第 1 行的抽取事件被尾部 100 行截断排除
    JSON.stringify({ version: '1.0', taskId: 'extract:pid0:被截断', runId: 'r0', sequence: 0, kind: 'run.started', at: '2026-10-13T01:00:00.000Z', provider: 'p', model: 'm' }),
  ]
  for (let i = 0; i < 105; i++) {
    lines.push(JSON.stringify({ version: '1.0', taskId: `noise:${i}`, runId: 'r', sequence: i, kind: 'model.admitted', at: 't', provider: 'p', model: 'm' }))
  }
  lines.push(JSON.stringify({ version: '1.0', taskId: 'extract:pid1:报告A', runId: 'r1', sequence: 1, kind: 'run.started', at: '2026-10-13T08:59:30.000Z', provider: 'minimax-cn', model: 'MiniMax-M3' }))
  lines.push(JSON.stringify({ version: '1.0', taskId: 'extract:pid1:报告A', runId: 'r1', sequence: 2, kind: 'run.finished', at: '2026-10-13T08:59:40.000Z', provider: 'minimax-cn', model: 'MiniMax-M3' }))
  lines.push(JSON.stringify({ version: '1.0', taskId: 'extract:pid2:报告B', runId: 'r2', sequence: 3, kind: 'run.finished', at: '2026-10-13T09:00:05.000Z', provider: 'minimax-cn', model: 'MiniMax-M3', reason: 'MODEL_FAILED' }))
  writeFileSync(auditPath, `${lines.join('\n')}\n`, 'utf-8')
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/agent/events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: unknown[] }
      expect(body.events).toEqual([
        { at: '2026-10-13T09:00:05.000Z', kind: 'failed', reason: 'MODEL_FAILED', model: 'MiniMax-M3', report: '报告B' },
        { at: '2026-10-13T08:59:40.000Z', kind: 'success', model: 'MiniMax-M3', report: '报告A' },
        { at: '2026-10-13T08:59:30.000Z', kind: 'start', model: 'MiniMax-M3', report: '报告A' },
      ]) // 最新在前；M6 taskId（extract:<projectId>:<slug>）投影 slug 段
    }, { agentAuditPath: auditPath })
  } finally {
    rmSync(auditDir, { recursive: true, force: true })
  }

  await withServer(async (base) => {
    const res = await fetch(`${base}/api/agent/events`)
    expect(await res.json()).toEqual({ events: [] }) // 审计文件不存在 → 空
  }, { agentAuditPath: join(tmpdir(), `dp-no-audit-${Date.now()}.jsonl`) })
})
