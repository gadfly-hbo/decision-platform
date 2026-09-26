import { createServer, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildDashboardData } from './dashboard'
import { readActionStore, writeActionStore, updateActionRecord, type StoredActionStatus } from './actions'
import {
  readNotifyConfig,
  readNotifyState,
  writeNotifyState,
  maybePushNewPeriod,
  buildWeeklyDigest,
  sendNotification,
} from './notify'

/** 默认端口避开兄弟项目：5173/4173/8787/8080/5021/2122/1234 均已占用 */
export const DEFAULT_PORT = 8642

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export interface ServerOptions {
  /** 周报数据目录（默认 <项目根>/data/raw），测试可注入 fixture 目录 */
  dataDir?: string
  /** 行动存储文件（默认 <项目根>/data/actions.json），测试可注入 tmp 文件 */
  actionsFile?: string
  /** 推送配置文件（默认 <项目根>/data/notify.json） */
  notifyFile?: string
  /** 推送幂等状态文件（默认 <项目根>/data/notify-state.json） */
  notifyStateFile?: string
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
  const actionsFile = options.actionsFile ?? join(process.cwd(), 'data', 'actions.json')
  const notifyFile = options.notifyFile ?? join(process.cwd(), 'data', 'notify.json')
  const notifyStateFile = options.notifyStateFile ?? join(process.cwd(), 'data', 'notify-state.json')
  const server = createServer((req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    } catch {
      // 畸形 request-target（如 "GET //"）-> 400，绝不击穿进程（REVIEW cycle 3 BLOCKER）
      return sendJson(res, 400, { error: '请求目标非法' })
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'decision-platform-server',
        time: new Date().toISOString(),
      })
    }
    const guard = (promise: Promise<void>): void => {
      void promise.catch((error: unknown) => {
        console.error('[server] 处理器异常：', error)
        if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message })
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      return guard(handleDashboard(res, { dataDir, actionsFile, notifyFile, notifyStateFile }))
    }
    if (req.method === 'POST' && url.pathname === '/api/notify/push') {
      return guard(handleNotifyPush(res, { dataDir, actionsFile, notifyFile, notifyStateFile }))
    }
    if (req.method === 'POST' && url.pathname === '/api/notify/test') {
      return guard(handleNotifyTest(res, notifyFile))
    }
    if (req.method === 'GET' && url.pathname === '/api/actions') {
      return sendJson(res, 200, readActionStore(actionsFile))
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/actions/')) {
      return guard(handleActionPut(req, res, url, actionsFile))
    }
    sendJson(res, 404, { error: 'not found' })
  })
  server.listen(port, host)
  return server
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

async function handleActionPut(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  actionsFile: string,
): Promise<void> {
  let actionId: string
  try {
    actionId = decodeURIComponent(url.pathname.slice('/api/actions/'.length))
  } catch {
    return sendJson(res, 400, { error: '行动 id 编码非法' })
  }
  if (!actionId) return sendJson(res, 400, { error: '缺少行动 id' })
  let body: { status?: unknown; executedNote?: unknown; period?: unknown; text?: unknown; dimension?: unknown }
  try {
    body = JSON.parse(await readBody(req)) as typeof body
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  if (body.period !== undefined && (typeof body.period !== 'string' || body.period === '')) {
    return sendJson(res, 400, { error: 'period 必须是非空字符串' })
  }
  let store: ReturnType<typeof updateActionRecord>
  try {
    store = updateActionRecord(
      readActionStore(actionsFile),
      actionId,
      {
        status: body.status as StoredActionStatus,
        ...(typeof body.executedNote === 'string' ? { executedNote: body.executedNote } : {}),
        ...(typeof body.text === 'string' ? { text: body.text } : {}),
        ...(typeof body.dimension === 'string' ? { dimension: body.dimension } : {}),
      },
      typeof body.period === 'string' ? body.period : '',
      new Date().toISOString(),
    )
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message })
  }
  try {
    writeActionStore(actionsFile, store)
  } catch (error) {
    return sendJson(res, 500, { error: `行动存储写入失败：${(error as Error).message}` })
  }
  sendJson(res, 200, store[actionId])
}

// 仅在 `npm run server`（tsx 直接执行本文件）时绑定默认端口；测试导入不监听
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT)
  startServer(port)
  console.log(`[decision-platform] backend listening on http://127.0.0.1:${port}`)
}

interface ServerPaths {
  dataDir: string
  actionsFile: string
  notifyFile: string
  notifyStateFile: string
}

async function handleDashboard(res: ServerResponse, paths: ServerPaths): Promise<void> {
  let data: ReturnType<typeof buildDashboardData>
  try {
    data = buildDashboardData(paths.dataDir, { actionsFile: paths.actionsFile })
  } catch (error) {
    // 引擎等代码缺陷：显式 5xx（PRD story 15），进程存活
    return sendJson(res, 500, { error: `看板数据构建失败：${(error as Error).message}` })
  }
  const config = readNotifyConfig(paths.notifyFile)
  if (config && data.period && !data.isDemo) {
    // 新期次首次推送（幂等）：fire-and-forget，失败只记日志，绝不阻塞看板响应（REVIEW cycle 1）
    void maybePushNewPeriod({
      config,
      stateFile: paths.notifyStateFile,
      period: data.period,
      digest: buildWeeklyDigest(data, readActionStore(paths.actionsFile)),
    }).catch((error: unknown) => {
      console.warn('[notify] 自动推送失败：', (error as Error).message)
    })
  }
  const state = readNotifyState(paths.notifyStateFile)
  sendJson(res, 200, {
    ...data,
    notify: {
      configured: config !== null,
      ...(state.lastPushedPeriod ? { lastPushedPeriod: state.lastPushedPeriod } : {}),
    },
  })
}

async function handleNotifyPush(res: ServerResponse, paths: ServerPaths): Promise<void> {
  const config = readNotifyConfig(paths.notifyFile)
  if (!config) return sendJson(res, 400, { error: '未配置推送（data/notify.json）' })
  const data = buildDashboardData(paths.dataDir, { actionsFile: paths.actionsFile })
  if (data.isDemo || !data.period) {
    return sendJson(res, 400, { error: '无真实期次数据，无法推送' })
  }
  try {
    // 手动重推 = 补救语义：即使本期已推过也真正再发一条（REVIEW cycle 1）
    await sendNotification(config, buildWeeklyDigest(data, readActionStore(paths.actionsFile)))
    writeNotifyState(paths.notifyStateFile, { lastPushedPeriod: data.period })
    sendJson(res, 200, { pushed: true, period: data.period })
  } catch (error) {
    sendJson(res, 502, { error: `推送失败：${(error as Error).message}` })
  }
}

async function handleNotifyTest(res: ServerResponse, notifyFile: string): Promise<void> {
  const config = readNotifyConfig(notifyFile)
  if (!config) return sendJson(res, 400, { error: '未配置推送（data/notify.json）' })
  try {
    await sendNotification(config, '【决策看板】测试推送：配置生效。')
    sendJson(res, 200, { sent: true })
  } catch (error) {
    sendJson(res, 502, { error: `测试推送失败：${(error as Error).message}` })
  }
}
