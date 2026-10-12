import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Server } from 'node:http'
import { startServer, type ServerOptions } from './index'
import type { ExtractionRunner } from './agent/extract'
import type { ActionItemDraft } from './agent/types'

/** 通知漏斗用假 runner：固定返回 1 条高优数据级行动项 */
const notifyRunner: ExtractionRunner = {
  async runExtraction(): Promise<ActionItemDraft[]> {
    return [
      {
        title: '对沉睡会员发放阶梯券',
        rationale: '复购率下滑',
        expectedImpact: '复购率 +2pp',
        priority: 'high',
        effort: 'medium',
        confidence: 0.92,
        evidence: { facts: [{ text: '复购率下滑', quote: '会员复购率由 12% 降至 9%' }], level: '数据支撑', reasoning: 'r' },
      },
    ]
  },
  async runExtractionRaw() {
    throw new Error('not used')
  },
}

const FIXTURE_DIR = join(tmpdir(), 'dp-server-fixture')
let emptyDir = ''

beforeAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(join(FIXTURE_DIR, '会员周报-2026-09-26.md'), '# 会员周报\n\n会员复购率由 12% 降至 9%。\n', 'utf-8')
  emptyDir = mkdtempSync(join(tmpdir(), 'dp-server-empty-'))
})

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  rmSync(emptyDir, { recursive: true, force: true })
})

async function withServer<T>(
  dataDir: string,
  fn: (base: string) => Promise<T>,
  extra: ServerOptions = {},
): Promise<T> {
  // M5：每个服务器实例独立临时库（默认 dbPath 会跨测试串库）
  const dbDir = mkdtempSync(join(tmpdir(), 'dp-server-db-'))
  const server: Server = startServer(0, '127.0.0.1', { dataDir, dbPath: join(dbDir, 'board.db'), ...extra })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  try {
    return await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dbDir, { recursive: true, force: true })
  }
}

test('GET /api/health 返回 ok 与服务名', async () => {
  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('decision-platform-server')
  })
})

test('GET /api/dashboard 返回行动闭环聚合（有报告）', async () => {
  const reportDir = mkdtempSync(join(tmpdir(), 'dp-server-md-'))
  writeFileSync(join(reportDir, '周报-0926.md'), '# 报告')
  await withServer(reportDir, async (base) => {
    const res = await fetch(`${base}/api/dashboard`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      isDemo: boolean
      reports: Array<{ filename: string }>
      actionItems: unknown[]
      stats: Record<string, number>
      modelChain: { available: boolean }
    }
    expect(body.isDemo).toBe(false)
    expect(body.reports[0].filename).toBe('周报-0926.md')
    expect(body.actionItems).toEqual([]) // 未抽取
    expect(body.stats).toMatchObject({ suggested: 0, adopted: 0, dismissed: 0, manual: 0 })
    expect(typeof body.modelChain.available).toBe('boolean')
  })
  rmSync(reportDir, { recursive: true, force: true })
})

test('GET /api/dashboard 无报告时空态（isDemo=true，前端演示回退依据）', async () => {
  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/api/dashboard`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { isDemo: boolean; reports: unknown[]; actionItems: unknown[] }
    expect(body.isDemo).toBe(true)
    expect(body.reports).toEqual([])
    expect(body.actionItems).toEqual([])
  })
})

test('未知路径返回 404 JSON', async () => {
  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/api/nope`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not found')
  })
})

/* ---- M3：推送端点与 notify 状态 ---- */

test('GET /api/dashboard 响应含 notify 状态（未配置）', async () => {
  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/api/dashboard`)
    const body = (await res.json()) as { notify: { configured: boolean } }
    expect(body.notify.configured).toBe(false)
  })
})

test('POST /api/notify/*：未配置 400；抽取完成后手动推送真发一轮并落 slug（webhook 降级四态）', async () => {
  const notifyFile = join(tmpdir(), `dp-notify-${Date.now()}.json`)
  await withServer(emptyDir, async (base) => {
    const noCfg = await fetch(`${base}/api/notify/test`, { method: 'POST' })
    expect(noCfg.status).toBe(400)
    const noCfgPush = await fetch(`${base}/api/notify/push`, { method: 'POST' })
    expect(noCfgPush.status).toBe(400)
  }, { notifyFile, notifyStateFile: `${notifyFile}.state` })

  writeFileSync(notifyFile, JSON.stringify({ platform: 'feishu', url: 'https://hook.example/t' }), 'utf-8')
  // 劫持外部 webhook；本机 server 请求走真 fetch
  const realFetch = globalThis.fetch.bind(globalThis)
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url as string, init)
    return { ok: true } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  await withServer(FIXTURE_DIR, async (base) => {
    const test = await fetch(`${base}/api/notify/test`, { method: 'POST' })
    expect(test.status).toBe(200)
    const webhookCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://'))
    expect(webhookCalls()).toHaveLength(1)

    // 报告未抽取（无 done）→ 手动推送 400
    const noDone = await fetch(`${base}/api/notify/push`, { method: 'POST' })
    expect(noDone.status).toBe(400)

    // 四态端点：webhook 已配置但未推送 → imConfigured=false（文本摘要降级呈现依据）、无 lastPushedReport
    const dash0 = (await (await fetch(`${base}/api/dashboard`)).json()) as { notify: Record<string, unknown> }
    expect(dash0.notify).toMatchObject({ configured: true, imConfigured: false })
    expect(dash0.notify.lastPushedReport).toBeUndefined()

    // 抽取完成 → 手动推送：摘要送达（行动闭环计数）+ slug 落状态
    const extract = await fetch(`${base}/api/reports/extract`, { method: 'POST', body: '{}' })
    expect(extract.status).toBe(200)
    const push1 = await fetch(`${base}/api/notify/push`, { method: 'POST' })
    expect(push1.status).toBe(200)
    const body1 = (await push1.json()) as { pushed: boolean; period: string }
    expect(body1).toEqual({ pushed: true, period: '会员周报-2026-09-26' })
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('https://hook.example/t')
    expect((init.body as string)).toContain('行动闭环周摘要')
    // REVIEW cycle 1：手动重推是"补救"语义——即使已推过也要真正再发一条
    const push2 = await fetch(`${base}/api/notify/push`, { method: 'POST' })
    expect(((await push2.json()) as { pushed: boolean }).pushed).toBe(true)
    // 指定 slug 定向重推同报告
    const push3 = await fetch(`${base}/api/notify/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: '会员周报-2026-09-26' }),
    })
    expect(push3.status).toBe(200)
    // test 推送 1 次 + 手动重推 3 次 = 4 次 webhook
    expect(webhookCalls()).toHaveLength(4)

    // 四态端点：推送成功 → lastPushedReport = slug
    const dash1 = (await (await fetch(`${base}/api/dashboard`)).json()) as { notify: Record<string, unknown> }
    expect(dash1.notify).toMatchObject({ configured: true, imConfigured: false, lastPushedReport: '会员周报-2026-09-26' })
  }, {
    notifyFile,
    notifyStateFile: `${notifyFile}.state`,
    dataDir: FIXTURE_DIR,
    agentRunner: notifyRunner,
    pushScan: async () => ({ pushed: false }), // 禁用调度漏斗，隔离手动路径
  })
  vi.unstubAllGlobals()
  rmSync(notifyFile, { force: true })
  rmSync(`${notifyFile}.state`, { force: true })
})

/* ---- REVIEW cycle 1：路由兜底与推送语义 ---- */

test('畸形行动项 id（decodeURIComponent 失败）→ 400 且进程存活', async () => {
  await withServer(emptyDir, async (base) => {
    const patch = await fetch(`${base}/api/actions/%`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(patch.status).toBe(400)
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
  })
})

test('目录缺失不再 500：报告扫描静默空态（M5 语义），健康检查存活', async () => {
  const badDir = join(tmpdir(), `dp-no-such-dir-${Date.now()}`)
  await withServer(badDir, async (base) => {
    const dash = await fetch(`${base}/api/dashboard`)
    expect(dash.status).toBe(200)
    const body = (await dash.json()) as { isDemo: boolean }
    expect(body.isDemo).toBe(true)
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
  })
})

test('自动推送不阻塞看板：webhook 挂起时 dashboard 快速返回', async () => {
  const notifyFile = join(tmpdir(), `dp-notify-slow-${Date.now()}.json`)
  writeFileSync(notifyFile, JSON.stringify({ platform: 'generic', url: 'https://slow.example/hook' }), 'utf-8')
  const realFetch = globalThis.fetch.bind(globalThis)
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url as string, init)
    return new Promise<Response>(() => {}) // webhook 永不返回
  }))
  try {
    await withServer(FIXTURE_DIR, async (base) => {
      const started = Date.now()
      const dash = await fetch(`${base}/api/dashboard`)
      expect(dash.status).toBe(200)
      expect(Date.now() - started).toBeLessThan(2000)
    }, { notifyFile, notifyStateFile: `${notifyFile}.state` })
  } finally {
    vi.unstubAllGlobals()
    rmSync(notifyFile, { force: true })
    rmSync(`${notifyFile}.state`, { force: true })
  }
})

test('畸形 request-target（GET //）→ 400 且进程存活（cycle 3 BLOCKER 回归）', async () => {
  const { connect } = await import('node:net')
  await withServer(emptyDir, async (base) => {
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

/* ---- M4a：静态文件服务（dist 生产模式）---- */

function makeDist(): string {
  const dist = mkdtempSync(join(tmpdir(), 'dp-dist-'))
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>决策看板</title>', 'utf-8')
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)', 'utf-8')
  return dist
}

test('GET / 服务 index.html；未知路由 SPA fallback；静态资源按类型直出；/api 优先', async () => {
  const dist = makeDist()
  await withServer(emptyDir, async (base) => {
    const root = await fetch(`${base}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toContain('text/html')
    expect(await root.text()).toContain('决策看板')

    const spa = await fetch(`${base}/some/deep/route`)
    expect(spa.status).toBe(200)
    expect(spa.headers.get('content-type')).toContain('text/html')
    expect(await spa.text()).toContain('决策看板')

    const asset = await fetch(`${base}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(await asset.text()).toBe('console.log(1)')

    // API 路由优先于静态服务：/api/nope 仍 404 JSON（不 fallback）
    const nope = await fetch(`${base}/api/nope`)
    expect(nope.status).toBe(404)
    expect(await nope.json()).toEqual({ error: 'not found' })
  }, { distDir: dist })
  rmSync(dist, { recursive: true, force: true })
})

test('dist 目录不存在 → 非 API GET 404，行为与现状一致', async () => {
  const missing = join(tmpdir(), `dp-no-dist-${Date.now()}`)
  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not found')
  }, { distDir: missing })
})

test('路径穿越尝试不出 dist（回退 index.html，不泄漏源码）', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'dp-dist-sec-'))
  writeFileSync(join(dist, 'index.html'), '<html>ok</html>', 'utf-8')
  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/%2e%2e/server/index.ts`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<html>ok</html>')
    expect(body).not.toContain('startServer')
  }, { distDir: dist })
  rmSync(dist, { recursive: true, force: true })
})

/* ---- M4b：推送通道编排（REVIEW cycle 1 MAJOR-1 回归）---- */

test('手动重推走 IM 通道（文本+高优卡片，按报告过滤）；webhook 文本不挡道；dashboard 四态含 imConfigured', async () => {
  const notifyFile = join(tmpdir(), `dp-notify-imfunnel-${Date.now()}.json`)
  writeFileSync(notifyFile, JSON.stringify({ platform: 'feishu', url: 'https://hook.example/f' }), 'utf-8')
  const stateFile = `${notifyFile}.state`
  const realFetch = globalThis.fetch.bind(globalThis)
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url as string, init)
    return { ok: true } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    const sent: Array<{ digest: string; cards: unknown[] }> = []
    const imChannel = {
      sendApproval: vi.fn(async (digest: string, cards: unknown[]) => {
        sent.push({ digest, cards })
      }),
    }
    await withServer(FIXTURE_DIR, async (base) => {
      // 四态端点：IM 通道已配置未推送
      const dash0 = (await (await fetch(`${base}/api/dashboard`)).json()) as { notify: Record<string, unknown> }
      expect(dash0.notify).toMatchObject({ configured: true, imConfigured: true })
      expect(dash0.notify.lastPushedReport).toBeUndefined()

      // 抽取（1 条 high+数据支撑 建议）→ 手动重推：IM 通道真发一轮（文本+该报告的卡片）
      const extract = await fetch(`${base}/api/reports/extract`, { method: 'POST', body: '{}' })
      expect(extract.status).toBe(200)
      const push = await fetch(`${base}/api/notify/push`, { method: 'POST' })
      expect(push.status).toBe(200)
      expect(((await push.json()) as { period: string }).period).toBe('会员周报-2026-09-26')
      expect(sent).toHaveLength(1)
      expect(sent[0].digest).toContain('建议 1')
      expect(sent[0].cards).toHaveLength(1)
      expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://'))).toHaveLength(0) // 不走群机器人

      const dash1 = (await (await fetch(`${base}/api/dashboard`)).json()) as { notify: Record<string, unknown> }
      expect(dash1.notify).toMatchObject({ configured: true, imConfigured: true, lastPushedReport: '会员周报-2026-09-26' })
    }, {
      dataDir: FIXTURE_DIR,
      notifyFile,
      notifyStateFile: stateFile,
      imChannel,
      agentRunner: notifyRunner,
      pushScan: async () => ({ pushed: false }), // 禁用调度漏斗，隔离手动路径
    })
  } finally {
    vi.unstubAllGlobals()
    rmSync(notifyFile, { recursive: true, force: true })
    rmSync(stateFile, { recursive: true, force: true })
  }
})

/* ---- M4a：推送扫描调度（KA1）---- */

test('服务启动即挂推送扫描，server.close 后定时器清理不泄漏', async () => {
  vi.useFakeTimers()
  try {
    const scan = vi.fn(async () => {})
    const server: Server = startServer(0, '127.0.0.1', {
      dataDir: emptyDir,
      pushScan: scan,
      pushScanIntervalMs: 1_000,
      pushScanFirstDelayMs: 10,
    })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    await vi.advanceTimersByTimeAsync(10)
    expect(scan).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(scan).toHaveBeenCalledTimes(2)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(scan).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

/* ---- M5 T7：账本/审计投影端点（S-R 运行详情数据源）---- */

test('GET /api/agent/usage：未注入 → available:false；注入假账本 → 快照与路径回显', async () => {
  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/api/agent/usage`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false })
  })
  await withServer(emptyDir, async (base) => {
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

test('GET /api/agent/events：审计尾部 ≤100 行投影 extract:*（最新在前、失败带原因）；非抽取任务过滤；文件缺失 → 空', async () => {
  const auditDir = mkdtempSync(join(tmpdir(), 'dp-agent-events-'))
  const auditPath = join(auditDir, 'agent-audit.jsonl')
  const lines: string[] = [
    // 第 1 行的抽取事件被尾部 100 行截断排除
    JSON.stringify({ version: '1.0', taskId: 'extract:被截断', runId: 'r0', sequence: 0, kind: 'run.started', at: '2026-10-13T01:00:00.000Z', provider: 'p', model: 'm' }),
  ]
  for (let i = 0; i < 105; i++) {
    lines.push(JSON.stringify({ version: '1.0', taskId: `noise:${i}`, runId: 'r', sequence: i, kind: 'model.admitted', at: 't', provider: 'p', model: 'm' }))
  }
  lines.push(JSON.stringify({ version: '1.0', taskId: 'extract:报告A', runId: 'r1', sequence: 1, kind: 'run.started', at: '2026-10-13T08:59:30.000Z', provider: 'minimax-cn', model: 'MiniMax-M3' }))
  lines.push(JSON.stringify({ version: '1.0', taskId: 'extract:报告A', runId: 'r1', sequence: 2, kind: 'run.finished', at: '2026-10-13T08:59:40.000Z', provider: 'minimax-cn', model: 'MiniMax-M3' }))
  lines.push(JSON.stringify({ version: '1.0', taskId: 'extract:报告B', runId: 'r2', sequence: 3, kind: 'run.finished', at: '2026-10-13T09:00:05.000Z', provider: 'minimax-cn', model: 'MiniMax-M3', reason: 'MODEL_FAILED' }))
  writeFileSync(auditPath, `${lines.join('\n')}\n`, 'utf-8')
  try {
    await withServer(emptyDir, async (base) => {
      const res = await fetch(`${base}/api/agent/events`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: unknown[] }
      expect(body.events).toEqual([
        { at: '2026-10-13T09:00:05.000Z', kind: 'failed', reason: 'MODEL_FAILED', model: 'MiniMax-M3', report: '报告B' },
        { at: '2026-10-13T08:59:40.000Z', kind: 'success', model: 'MiniMax-M3', report: '报告A' },
        { at: '2026-10-13T08:59:30.000Z', kind: 'start', model: 'MiniMax-M3', report: '报告A' },
      ]) // 最新在前；noise:* 与被截断的最早抽取行不出现
    }, { agentAuditPath: auditPath })
  } finally {
    rmSync(auditDir, { recursive: true, force: true })
  }

  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/api/agent/events`)
    expect(await res.json()).toEqual({ events: [] }) // 审计文件不存在 → 空
  }, { agentAuditPath: join(tmpdir(), `dp-no-audit-${Date.now()}.jsonl`) })
})
