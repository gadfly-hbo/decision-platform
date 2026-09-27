import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildDashboardData } from './dashboard'
import { readActionStore, writeActionStore, updateActionRecord, type StoredActionStatus } from './actions'
import {
  readNotifyConfig,
  readNotifyState,
  writeNotifyState,
  buildWeeklyDigest,
  sendNotification,
  scanAndPush,
  startPushScheduler,
  type ImPushChannel,
} from './notify'
import { readImConfig, buildApprovalCards } from './im'
import { startFeishuBridge } from './im-feishu'

/** 默认端口避开兄弟项目：5173/4173/8787/8080/5021/2122/1234 均已占用 */
export const DEFAULT_PORT = 8642

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** dist 静态服务：真实文件直出 + 未知路径 SPA fallback（/api 前缀永不进此函数） */
function serveStatic(res: ServerResponse, distDir: string, pathname: string): void {
  if (!existsSync(distDir)) return sendJson(res, 404, { error: 'not found' })
  let rel = ''
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    rel = '' // 畸形编码按根路径处理 → fallback
  }
  const abs = resolve(distDir, rel)
  let file: string | null = null
  if (abs === distDir || abs.startsWith(distDir + sep)) {
    try {
      if (statSync(abs).isFile()) file = abs
    } catch {
      // 不存在 → fallback
    }
  }
  if (!file) {
    const index = join(distDir, 'index.html')
    if (!existsSync(index)) return sendJson(res, 404, { error: 'not found' })
    file = index
  }
  const dot = file.lastIndexOf('.')
  const ext = dot >= 0 ? file.slice(dot) : ''
  res.writeHead(200, { 'content-type': STATIC_MIME[ext] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
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
  /** 前端构建产物目录（默认 <项目根>/dist）；存在时非 API GET 走静态服务 */
  distDir?: string
  /** 测试注入：替换定时扫描动作（默认 scanAndPush） */
  pushScan?: () => Promise<unknown>
  /** 测试注入：扫描间隔 ms（默认 60000） */
  pushScanIntervalMs?: number
  /** 测试注入：启动首扫延迟 ms（默认 2000） */
  pushScanFirstDelayMs?: number
  /** M4：IM 推送通道（飞书/钉钉桥接）；缺席时扫描推送回落群机器人 webhook */
  imChannel?: ImPushChannel
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
  const distDir = options.distDir ?? join(process.cwd(), 'dist')
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
      return guard(handleDashboard(res, { dataDir, actionsFile, notifyFile, notifyStateFile, imChannel: options.imChannel }))
    }
    if (req.method === 'POST' && url.pathname === '/api/notify/push') {
      return guard(handleNotifyPush(res, { dataDir, actionsFile, notifyFile, notifyStateFile, imChannel: options.imChannel }))
    }
    if (req.method === 'POST' && url.pathname === '/api/notify/test') {
      return guard(handleNotifyTest(res, notifyFile, options.imChannel))
    }
    if (req.method === 'GET' && url.pathname === '/api/actions') {
      return sendJson(res, 200, readActionStore(actionsFile))
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/actions/')) {
      return guard(handleActionPut(req, res, url, actionsFile))
    }
    if (req.method === 'GET' && url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return serveStatic(res, distDir, url.pathname)
    }
    sendJson(res, 404, { error: 'not found' })
  })
  // M4a：推送扫描调度（KA1）——新期次不依赖任何人打开看板；server.close 时清理定时器
  const stopScheduler = startPushScheduler(
    options.pushScan ?? (() => scanAndPush({ dataDir, actionsFile, notifyFile, notifyStateFile, imChannel: options.imChannel })),
    options.pushScanIntervalMs ?? 60_000,
    options.pushScanFirstDelayMs ?? 2_000,
  )
  server.on('close', stopScheduler)
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

// 仅在 `npm run server` / `npm run prod`（tsx 直接执行本文件）时绑定端口并拉起 IM 桥接；测试导入不监听
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT)
  const host = process.env.HOST ?? '127.0.0.1'
  const dataDir = join(process.cwd(), 'data', 'raw')
  const actionsFile = join(process.cwd(), 'data', 'actions.json')
  // M4：配置了飞书（data/im.json）→ 长连接桥接（零公网入站）；无配置跳过，推送回落群机器人
  let imChannel: ImPushChannel | undefined
  let stopBridge: (() => Promise<void>) | undefined
  const imConf = readImConfig(join(process.cwd(), 'data', 'im.json'))
  const feishuConf = imConf?.platforms.find((p) => p.platform === 'feishu')
  if (feishuConf) {
    try {
      const bridge = await startFeishuBridge({ config: feishuConf, actionsFile, dataDir })
      imChannel = bridge
      stopBridge = () => bridge.stop()
      console.log('[im:feishu] 长连接桥接已启动（审批卡片就绪）')
    } catch (error) {
      console.warn('[im:feishu] 桥接启动失败，推送回落群机器人文本摘要：', (error as Error).message)
    }
  }
  const server = startServer(port, host, { dataDir, actionsFile, imChannel })
  if (stopBridge) server.on('close', () => void stopBridge!())
  console.log(`[decision-platform] backend listening on http://${host}:${port}`)
}

interface ServerPaths {
  dataDir: string
  actionsFile: string
  notifyFile: string
  notifyStateFile: string
  imChannel?: ImPushChannel
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
  if ((config || paths.imChannel) && data.period && !data.isDemo) {
    // 看板访问兜底：与调度器同一漏斗（scanAndPush 幂等，IM 通道=文本+卡片），
    // 绝不允许 webhook 文本先落状态把整期审批卡片挡死（REVIEW cycle 1 MAJOR-1）
    void scanAndPush({
      dataDir: paths.dataDir,
      actionsFile: paths.actionsFile,
      notifyFile: paths.notifyFile,
      notifyStateFile: paths.notifyStateFile,
      imChannel: paths.imChannel,
    }).catch((error: unknown) => {
      console.warn('[notify] 看板兜底推送失败：', (error as Error).message)
    })
  }
  const state = readNotifyState(paths.notifyStateFile)
  sendJson(res, 200, {
    ...data,
    notify: {
      configured: config !== null || paths.imChannel !== undefined,
      ...(state.lastPushedPeriod ? { lastPushedPeriod: state.lastPushedPeriod } : {}),
    },
  })
}

async function handleNotifyPush(res: ServerResponse, paths: ServerPaths): Promise<void> {
  const config = readNotifyConfig(paths.notifyFile)
  const imChannel = paths.imChannel
  if (!config && !imChannel) return sendJson(res, 400, { error: '未配置推送（data/notify.json 或 data/im.json）' })
  const data = buildDashboardData(paths.dataDir, { actionsFile: paths.actionsFile })
  if (data.isDemo || !data.period) {
    return sendJson(res, 400, { error: '无真实期次数据，无法推送' })
  }
  try {
    // 手动重推 = 补救语义：即使本期已推过也真正再发一轮（IM 通道=文本+高优卡片）
    if (imChannel) {
      await imChannel.sendApproval(buildWeeklyDigest(data, readActionStore(paths.actionsFile)), buildApprovalCards(data))
    } else {
      await sendNotification(config!, buildWeeklyDigest(data, readActionStore(paths.actionsFile)))
    }
    writeNotifyState(paths.notifyStateFile, { lastPushedPeriod: data.period })
    sendJson(res, 200, { pushed: true, period: data.period })
  } catch (error) {
    sendJson(res, 502, { error: `推送失败：${(error as Error).message}` })
  }
}

async function handleNotifyTest(res: ServerResponse, notifyFile: string, imChannel?: ImPushChannel): Promise<void> {
  const config = readNotifyConfig(notifyFile)
  if (!config && !imChannel) return sendJson(res, 400, { error: '未配置推送（data/notify.json 或 data/im.json）' })
  try {
    if (imChannel) await imChannel.sendApproval('【决策看板】测试推送：配置生效。', [])
    else await sendNotification(config!, '【决策看板】测试推送：配置生效。')
    sendJson(res, 200, { sent: true })
  } catch (error) {
    sendJson(res, 502, { error: `测试推送失败：${(error as Error).message}` })
  }
}
