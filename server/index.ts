import { createServer, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildDashboardData } from './dashboard'

/** 默认端口避开兄弟项目：5173/4173/8787/8080/5021/2122/1234 均已占用 */
export const DEFAULT_PORT = 8642

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export interface ServerOptions {
  /** 周报数据目录（默认 <项目根>/data/raw），测试可注入 fixture 目录 */
  dataDir?: string
}

/**
 * M2：/api/dashboard 由 dataDir 最新周报计算（解析 → 规则引擎 → DashboardData）；
 * 无数据/解析失败回退演示数据（isDemo=true）。M2 之前的最小后端仅 health + demoData。
 */
export function startServer(
  port: number = DEFAULT_PORT,
  host = '127.0.0.1',
  options: ServerOptions = {},
): Server {
  const dataDir = options.dataDir ?? join(process.cwd(), 'data', 'raw')
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'decision-platform-server',
        time: new Date().toISOString(),
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      return sendJson(res, 200, buildDashboardData(dataDir))
    }
    sendJson(res, 404, { error: 'not found' })
  })
  server.listen(port, host)
  return server
}

// 仅在 `npm run server`（tsx 直接执行本文件）时绑定默认端口；测试导入不监听
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT)
  startServer(port)
  console.log(`[decision-platform] backend listening on http://127.0.0.1:${port}`)
}
