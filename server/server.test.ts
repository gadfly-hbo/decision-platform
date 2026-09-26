import type { Server } from 'node:http'
import { startServer } from './index'

const server: Server = startServer(0)

beforeAll(async () => {
  if (server.listening) return
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const baseUrl = () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

test('GET /api/health 返回 ok 与服务名', async () => {
  const res = await fetch(`${baseUrl()}/api/health`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; service: string }
  expect(body.ok).toBe(true)
  expect(body.service).toBe('decision-platform-server')
})

test('GET /api/dashboard 返回与前端数据层一致的看板数据', async () => {
  const res = await fetch(`${baseUrl()}/api/dashboard`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { title: string; conclusions: unknown[] }
  expect(body.title).toBe('决策看板')
  expect(body.conclusions).toHaveLength(4)
})

test('未知路径返回 404 JSON', async () => {
  const res = await fetch(`${baseUrl()}/api/nope`)
  expect(res.status).toBe(404)
  const body = (await res.json()) as { error: string }
  expect(body.error).toBe('not found')
})
