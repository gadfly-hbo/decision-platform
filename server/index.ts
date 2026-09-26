import { createServer, type Server, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import { demoData } from '../src/data/demo'

/** 默认端口避开兄弟项目：5173/4173/8787/8080/5021/2122/1234 均已占用 */
export const DEFAULT_PORT = 8642

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * M2 前的最小后端：为「一键启动前后端」提供真实进程，并 seed 数据源接口。
 * /api/dashboard 直接复用前端数据层的 demoData（单一事实源），M2 接 DuckDB 后替换实现。
 */
export function startServer(port: number = DEFAULT_PORT, host = '127.0.0.1'): Server {
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
      return sendJson(res, 200, demoData)
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
