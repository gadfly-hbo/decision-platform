import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Server } from 'node:http'
import { startServer, type ServerOptions } from './index'

const FIXTURE_DIR = join(tmpdir(), 'dp-server-fixture')
let emptyDir = ''

beforeAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  cpSync(join(__dirname, 'report/testdata', 'sample.csv'), join(FIXTURE_DIR, '会员周报-2026-09-26.csv'))
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
  const server: Server = startServer(0, '127.0.0.1', { dataDir, ...extra })
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
  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; service: string }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('decision-platform-server')
  })
})

test('GET /api/dashboard 返回真实周报计算结果（注入 fixture 目录）', async () => {
  await withServer(FIXTURE_DIR, async (base) => {
    const res = await fetch(`${base}/api/dashboard`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      isDemo: boolean
      period: string
      conclusions: Array<{ severity: string; title: string }>
    }
    expect(body.isDemo).toBe(false)
    expect(body.period).toBe('2026-09-26')
    expect(body.conclusions[0].severity).toBe('high')
    expect(body.conclusions[0].title).toContain('背离')
  })
})

test('GET /api/dashboard 无数据时回退演示数据（isDemo=true）', async () => {
  await withServer(emptyDir, async (base) => {
    const res = await fetch(`${base}/api/dashboard`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { isDemo: boolean; conclusions: unknown[]; series: unknown[] }
    expect(body.isDemo).toBe(true)
    expect(body.conclusions).toHaveLength(4)
    expect(body.series.length).toBeGreaterThan(0)
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

test('PUT/GET /api/actions：行动状态持久化与读取（注入 tmp 文件）', async () => {
  const actionsFile = join(tmpdir(), `dp-actions-api-${Date.now()}.json`)
  rmSync(actionsFile, { force: true })
  await withServer(emptyDir, async (base) => {
    const put = await fetch(`${base}/api/actions/${encodeURIComponent('c-divergence')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'executed', executedNote: '预算已调整', period: '2026-09-26' }),
    })
    expect(put.status).toBe(200)
    const record = (await put.json()) as { status: string; executedNote: string }
    expect(record.status).toBe('executed')

    const got = await fetch(`${base}/api/actions`)
    const store = (await got.json()) as Record<string, { status: string }>
    expect(store['c-divergence'].status).toBe('executed')
  }, { actionsFile })
  rmSync(actionsFile, { force: true })
})

test('PUT /api/actions 非法 status → 400', async () => {
  await withServer(emptyDir, async (base) => {
    const put = await fetch(`${base}/api/actions/x`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(put.status).toBe(400)
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

test('POST /api/notify/* 未配置 → 400；测试推送配置后 → 200', async () => {
  const notifyFile = join(tmpdir(), `dp-notify-${Date.now()}.json`)
  await withServer(emptyDir, async (base) => {
    const noCfg = await fetch(`${base}/api/notify/test`, { method: 'POST' })
    expect(noCfg.status).toBe(400)
  }, { notifyFile, notifyStateFile: `${notifyFile}.state` })

  writeFileSync(notifyFile, JSON.stringify({ platform: 'feishu', url: 'https://hook.example/t' }), 'utf-8')
  // 劫持外部 webhook；本机 server 请求走真 fetch
  const realFetch = globalThis.fetch.bind(globalThis)
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url as string, init)
    return { ok: true } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  await withServer(emptyDir, async (base) => {
    const test = await fetch(`${base}/api/notify/test`, { method: 'POST' })
    expect(test.status).toBe(200)
    const webhookCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://'))
    expect(webhookCalls()).toHaveLength(1)

    // 真实数据 + 手动推送：摘要送达，幂等状态落盘，二次推送跳过
    const push1 = await fetch(`${base}/api/notify/push`, { method: 'POST' })
    expect(push1.status).toBe(200)
    const body1 = (await push1.json()) as { pushed: boolean }
    expect(body1.pushed).toBe(true)
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('https://hook.example/t')
    expect((init.body as string)).toContain('背离')
    // REVIEW cycle 1：手动重推是"补救"语义——即使已推过也要真正再发一条
    const push2 = await fetch(`${base}/api/notify/push`, { method: 'POST' })
    const body2 = (await push2.json()) as { pushed: boolean }
    expect(body2.pushed).toBe(true)
    // test 推送 1 次 + 手动重推 2 次 = 3 次 webhook
    expect(webhookCalls()).toHaveLength(3)
  }, { notifyFile, notifyStateFile: `${notifyFile}.state`, dataDir: FIXTURE_DIR })
  vi.unstubAllGlobals()
  rmSync(notifyFile, { force: true })
  rmSync(`${notifyFile}.state`, { force: true })
})

/* ---- REVIEW cycle 1：路由兜底与推送语义 ---- */

test('畸形行动 id（decodeURIComponent 失败）→ 400 且进程存活', async () => {
  await withServer(emptyDir, async (base) => {
    const put = await fetch(`${base}/api/actions/%`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(put.status).toBe(400)
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
  })
})

test('非解析类异常（目录缺失）→ /api/dashboard 500 且 /api/health 存活', async () => {
  const badDir = join(tmpdir(), `dp-no-such-dir-${Date.now()}`)
  await withServer(badDir, async (base) => {
    const dash = await fetch(`${base}/api/dashboard`)
    expect(dash.status).toBe(500)
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
