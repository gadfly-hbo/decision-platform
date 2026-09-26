import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { startServer } from './index'

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

async function withServer<T>(dataDir: string, fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = startServer(0, '127.0.0.1', { dataDir })
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
