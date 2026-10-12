import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  readNotifyConfig,
  readNotifyState,
  latestPushedSlug,
  markSlugPushed,
  buildWeeklyDigest,
  sendNotification,
  runPushFunnel,
  startPushScheduler,
  type ImPushChannel,
} from './notify'
import { readImConfig, buildApprovalCards } from './im'
import { startFeishuBridge } from './im-feishu'
import { composeDefaultAgent } from './agent/compose'
import type { ExtractionRunner } from './agent/extract'
import type { BoardView, ReportRecord } from '../src/data/types'
import { getReportBySlug } from './db'
import { createReportPipeline, scanReports, type ReportPipeline } from './reports'
import {
  applyActionPatch,
  buildBoardView,
  createManualAction,
  createTask,
  patchTask,
  readFeedback,
  removeActionItem,
  saveFeedback,
  type ActionPatchInput,
  type FeedbackInput,
  type ManualActionInput,
  type TaskCreateInput,
  type TaskPatchInput,
} from './board'

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
  /** 报告数据目录（默认 <项目根>/data/raw），扫描 .md/.txt；旧 CSV 不再读取 */
  dataDir?: string
  /** 推送配置文件（默认 <项目根>/data/notify.json） */
  notifyFile?: string
  /** 推送幂等状态文件（默认 <项目根>/data/notify-state.json） */
  notifyStateFile?: string
  /** 前端构建产物目录（默认 <项目根>/dist）；存在时非 API GET 走静态服务 */
  distDir?: string
  /** 测试注入：替换定时推送漏斗（默认 runPushFunnel：扫描→抽取→按报告推送） */
  pushScan?: () => Promise<unknown>
  /** 测试注入：扫描间隔 ms（默认 60000） */
  pushScanIntervalMs?: number
  /** 测试注入：启动首扫延迟 ms（默认 2000） */
  pushScanFirstDelayMs?: number
  /** IM 推送通道（飞书桥接）；缺席时扫描推送回落群机器人 webhook */
  imChannel?: ImPushChannel
  /** M5：SQLite 库路径（默认 <项目根>/data/board.db）；懒创建，仅报告路由触碰 */
  dbPath?: string
  /** M5：共享报告管线注入（生产 boot 与飞书桥接共用同一 db 连接）；缺省懒创建 */
  pipeline?: ReportPipeline
  /** M5：抽取 runner 注入（测试用假 runner / 生产 composeDefaultAgent）；缺席时抽取端点 503 */
  agentRunner?: ExtractionRunner
  /** M5 T7：任务账本注入（生产传 composeDefaultAgent 的 store；缺席时 /api/agent/usage 返回 available:false） */
  agentLedger?: AgentLedgerProjection
  /** M5 T7：审计 JSONL 路径（默认 <项目根>/data/agent-audit.jsonl）；/api/agent/events 投影源 */
  agentAuditPath?: string
}

/** S-R 运行详情的账本投影缝：FileBudgetStore 结构兼容（多余字段不透出；ledgerPath 供回显） */
export interface AgentLedgerProjection {
  usageTotals(): AgentUsageTotals
  usageOf(taskId: string): AgentUsageTotals | null
  ledgerPath?: string
}

export interface AgentUsageTotals {
  modelCalls: number
  inputTokens: number
  outputTokens: number
  activeMs: number
  toolCalls: number
  resourceUnits: number
}

/** 账本用量 → 投影形状（Usage.inputTokens 可选，归一为 0；其余字段透传） */
function toUsageTotals(usage: {
  modelCalls: number
  toolCalls: number
  outputTokens: number
  resourceUnits: number
  activeMs: number
  inputTokens?: number
}): AgentUsageTotals {
  return {
    modelCalls: usage.modelCalls,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens,
    activeMs: usage.activeMs,
    toolCalls: usage.toolCalls,
    resourceUnits: usage.resourceUnits,
  }
}

/** 审计 JSONL → 抽取事件时间线投影（安全元数据：at/kind/reason/model + 报告 slug） */
export interface AgentEventEntry {
  at: string
  kind: 'start' | 'success' | 'failed'
  reason?: string
  model: string
  report: string
}

const AUDIT_TAIL_LINES = 100

/** 读审计尾部 ≤100 行，投影 extract:* 任务的 run.started/run.finished，最新在前 */
export function projectAgentEvents(auditPath: string): AgentEventEntry[] {
  let raw: string
  try {
    raw = readFileSync(auditPath, 'utf-8')
  } catch {
    return [] // 文件不存在/不可读：空时间线（UI 空态文案承接）
  }
  const entries: AgentEventEntry[] = []
  for (const line of raw.split('\n').slice(-AUDIT_TAIL_LINES)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: { taskId?: unknown; kind?: unknown; at?: unknown; reason?: unknown; model?: unknown }
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue // 损坏行跳过，不阻塞投影
    }
    if (typeof event.taskId !== 'string' || !event.taskId.startsWith('extract:')) continue
    const report = event.taskId.slice('extract:'.length)
    if (event.kind === 'run.started') {
      entries.push({ at: String(event.at ?? ''), kind: 'start', model: String(event.model ?? ''), report })
    } else if (event.kind === 'run.finished') {
      const reason = typeof event.reason === 'string' ? event.reason : undefined
      entries.push({
        at: String(event.at ?? ''),
        kind: reason ? 'failed' : 'success',
        ...(reason ? { reason } : {}),
        model: String(event.model ?? ''),
        report,
      })
    }
  }
  return entries.reverse() // 文件追加序（旧→新）反转为最新在前
}

/**
 * M5 行动闭环服务：报告扫描/抽取 + 行动项确认/任务/反馈 + 推送漏斗（BoardView 聚合）。
 */
export function startServer(
  port: number = DEFAULT_PORT,
  host = '127.0.0.1',
  options: ServerOptions = {},
): Server {
  const dataDir = options.dataDir ?? join(process.cwd(), 'data', 'raw')
  const notifyFile = options.notifyFile ?? join(process.cwd(), 'data', 'notify.json')
  const notifyStateFile = options.notifyStateFile ?? join(process.cwd(), 'data', 'notify-state.json')
  const agentAuditPath = options.agentAuditPath ?? join(process.cwd(), 'data', 'agent-audit.jsonl')
  const distDir = options.distDir ?? join(process.cwd(), 'dist')
  // 报告管线懒创建（首次命中报告路由才开库；注入管线时直接共用，供飞书桥接同连接写库）
  let pipeline: ReportPipeline | null = options.pipeline ?? null
  const dbPath = options.dbPath ?? join(process.cwd(), 'data', 'board.db')
  const getPipeline = (): ReportPipeline => {
    if (!pipeline) pipeline = createReportPipeline(dataDir, dbPath)
    return pipeline
  }
  const notifyConfigured = (): boolean => readNotifyConfig(notifyFile) !== null || Boolean(options.imChannel)
  const loadBoardView = (): BoardView => {
    const p = getPipeline()
    scanReports(p.db, dataDir)
    return buildBoardView(p.db, {
      notifyConfigured: notifyConfigured(),
      imConfigured: Boolean(options.imChannel),
      lastPushedReport: latestPushedSlug(readNotifyState(notifyStateFile)),
    })
  }
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
    if (req.method === 'GET' && url.pathname === '/api/agent/usage') {
      // S-R 运行详情：任务账本快照；未注入（无模型链/测试）→ available:false
      const ledger = options.agentLedger
      if (!ledger) return sendJson(res, 200, { available: false })
      const totals = ledger.usageTotals()
      return sendJson(res, 200, {
        available: true,
        totals: {
          modelCalls: totals.modelCalls,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          activeMs: totals.activeMs,
          toolCalls: totals.toolCalls,
          resourceUnits: totals.resourceUnits,
        },
        ...(ledger.ledgerPath ? { ledgerPath: ledger.ledgerPath } : {}),
        auditPath: agentAuditPath,
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/agent/events') {
      return sendJson(res, 200, { events: projectAgentEvents(agentAuditPath) })
    }
    const guard = (promise: Promise<void>): void => {
      void promise.catch((error: unknown) => {
        console.error('[server] 处理器异常：', error)
        if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message })
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/reports') {
      const reports: ReportRecord[] = scanReports(getPipeline().db, dataDir)
      return sendJson(res, 200, { reports })
    }
    if (req.method === 'POST' && url.pathname === '/api/reports/extract') {
      return guard(handleReportsExtract(req, res, { getPipeline, runner: options.agentRunner ?? null, dataDir }))
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      return sendJson(res, 200, loadBoardView())
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/actions/')) {
      return guard(handleActionPatch(req, res, url, getPipeline))
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/actions/')) {
      let id: string
      try {
        id = actionIdFrom(url, '/api/actions/') ?? ''
      } catch {
        return sendJson(res, 400, { error: '行动项 id 编码非法' })
      }
      if (!id) return sendJson(res, 400, { error: '缺少行动项 id' })
      const outcome = removeActionItem(getPipeline().db, id)
      if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
      return sendJson(res, 200, { deleted: true, id })
    }
    if (req.method === 'POST' && url.pathname === '/api/actions') {
      return guard(handleManualActionCreate(req, res, getPipeline))
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/actions/') && url.pathname.endsWith('/tasks')) {
      return guard(handleTaskCreate(req, res, url, getPipeline))
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) {
      return guard(handleTaskPatch(req, res, url, getPipeline))
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/feedback')) {
      return guard(handleFeedbackSave(req, res, url, getPipeline))
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/feedback')) {
      return handleFeedbackGet(res, url, getPipeline)
    }
    if (req.method === 'POST' && url.pathname === '/api/notify/push') {
      return guard(handleNotifyPush(req, res, { loadBoardView, notifyFile, notifyStateFile, imChannel: options.imChannel }))
    }
    if (req.method === 'POST' && url.pathname === '/api/notify/test') {
      return guard(handleNotifyTest(res, notifyFile, options.imChannel))
    }
    if (req.method === 'GET' && url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return serveStatic(res, distDir, url.pathname)
    }
    sendJson(res, 404, { error: 'not found' })
  })
  // 推送漏斗调度：扫描 → 自动抽取 → 每报告推一轮；新报告不依赖任何人打开看板
  const stopScheduler = startPushScheduler(
    options.pushScan ?? (() =>
      runPushFunnel({
        pipeline: getPipeline(),
        agentRunner: options.agentRunner ?? null,
        notifyFile,
        notifyStateFile,
        ...(options.imChannel ? { imChannel: options.imChannel } : {}),
      })),
    options.pushScanIntervalMs ?? 60_000,
    options.pushScanFirstDelayMs ?? 2_000,
  )
  server.on('close', stopScheduler)
  server.on('close', () => pipeline?.close())
  server.listen(port, host)
  return server
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

// 仅在 `npm run server` / `npm run prod`（tsx 直接执行本文件）时绑定端口并拉起 IM 桥接；测试导入不监听
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT)
  const host = process.env.HOST ?? '127.0.0.1'
  const dataDir = join(process.cwd(), 'data', 'raw')
  // 生产先建管线：服务器与飞书桥接共用同一 db 连接（避免双连接写竞争）
  const pipeline = createReportPipeline(dataDir, join(process.cwd(), 'data', 'board.db'))
  // 配置了飞书（data/im.json）→ 长连接桥接（零公网入站）；无配置跳过，推送回落群机器人
  let imChannel: ImPushChannel | undefined
  let stopBridge: (() => Promise<void>) | undefined
  const imConf = readImConfig(join(process.cwd(), 'data', 'im.json'))
  const feishuConf = imConf?.platforms.find((p) => p.platform === 'feishu')
  if (feishuConf) {
    try {
      const bridge = await startFeishuBridge({ config: feishuConf, db: pipeline.db })
      imChannel = bridge
      stopBridge = () => bridge.stop()
      console.log('[im:feishu] 长连接桥接已启动（审批卡片就绪）')
    } catch (error) {
      console.warn('[im:feishu] 桥接启动失败，推送回落群机器人文本摘要：', (error as Error).message)
    }
  }
  // M5：生产装配抽取 runner（密钥缺失降级为 503，不阻塞看板其他能力）；账本实例供 S-R 运行详情投影
  let agentRunner: ReturnType<typeof composeDefaultAgent>['runner'] | undefined
  let agentLedger: AgentLedgerProjection | undefined
  let agentAuditPath: string | undefined
  try {
    const composed = composeDefaultAgent(join(process.cwd(), 'data'))
    agentRunner = composed.runner
    agentLedger = {
      usageTotals: () => toUsageTotals(composed.store.usageTotals()),
      usageOf: (taskId) => {
        const usage = composed.store.usageOf(taskId)
        return usage === null ? null : toUsageTotals(usage)
      },
      ledgerPath: composed.ledgerPath,
    }
    agentAuditPath = composed.auditPath
    console.log('[agent] 抽取 runner 就绪（模型链已装配）')
  } catch (error) {
    console.warn('[agent] 模型链不可用，抽取端点将返回 503：', (error as Error).message)
  }
  const server = startServer(port, host, {
    dataDir,
    pipeline,
    ...(imChannel ? { imChannel } : {}),
    ...(agentRunner ? { agentRunner } : {}),
    ...(agentLedger ? { agentLedger } : {}),
    ...(agentAuditPath ? { agentAuditPath } : {}),
  })
  if (stopBridge) server.on('close', () => void stopBridge!())
  console.log(`[decision-platform] backend listening on http://${host}:${port}`)
}

interface NotifyPushDeps {
  loadBoardView: () => BoardView
  notifyFile: string
  notifyStateFile: string
  imChannel?: ImPushChannel
}

interface ReportsExtractDeps {
  getPipeline: () => ReportPipeline
  runner: ExtractionRunner | null
  dataDir: string
}

async function handleReportsExtract(req: import('node:http').IncomingMessage, res: ServerResponse, deps: ReportsExtractDeps): Promise<void> {
  let body: { slug?: unknown; force?: unknown }
  try {
    body = JSON.parse((await readBody(req)) || '{}') as typeof body
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const slug = typeof body.slug === 'string' && body.slug !== '' ? body.slug : undefined
  const force = body.force === true
  if (!deps.runner) {
    return sendJson(res, 503, { error: '模型不可用：未注入抽取 runner（未配置密钥或服务未装配），请检查 ~/.pi/agent/auth.json 或环境变量' })
  }
  const pipeline = deps.getPipeline()
  scanReports(pipeline.db, deps.dataDir)
  if (slug && !getReportBySlug(pipeline.db, slug)) {
    return sendJson(res, 404, { error: `报告不存在：${slug}` })
  }
  const results = await pipeline.extract(deps.runner, { slug, force })
  sendJson(res, 200, { results })
}

async function handleNotifyPush(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  deps: NotifyPushDeps,
): Promise<void> {
  const config = readNotifyConfig(deps.notifyFile)
  const imChannel = deps.imChannel
  if (!config && !imChannel) return sendJson(res, 400, { error: '未配置推送（data/notify.json 或 data/im.json）' })
  let body: { slug?: unknown }
  try {
    body = JSON.parse((await readBody(req)) || '{}') as typeof body
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const slug = typeof body.slug === 'string' && body.slug !== '' ? body.slug : undefined
  const view = deps.loadBoardView()
  const doneReports = view.reports.filter((report) => report.status === 'done')
  // 手动重推 = 补救语义：指定 slug 真发该报告一轮；缺省取最新 done 报告；无 done 报告（含演示空态）拒绝
  const target = slug ? doneReports.find((report) => report.slug === slug) : doneReports[0]
  if (!target) {
    if (slug && view.reports.some((report) => report.slug === slug)) {
      return sendJson(res, 400, { error: `报告未抽取完成，无法推送：${slug}` })
    }
    if (slug) return sendJson(res, 404, { error: `报告不存在：${slug}` })
    return sendJson(res, 400, { error: '无已抽取完成的报告，无法推送' })
  }
  try {
    const digest = buildWeeklyDigest(view)
    if (imChannel) {
      await imChannel.sendApproval(digest, buildApprovalCards(view, { reportId: target.id }))
    } else {
      await sendNotification(config!, digest)
    }
    markSlugPushed(deps.notifyStateFile, target.slug)
    sendJson(res, 200, { pushed: true, period: target.slug })
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

// ---- M5：行动闭环路由处理器 ----

function actionIdFrom(url: URL, prefix: string, suffix = ''): string | null {
  const rest = url.pathname.slice(prefix.length)
  if (suffix && !rest.endsWith(suffix)) return null
  const id = decodeURIComponent(suffix ? rest.slice(0, -suffix.length) : rest)
  return id || null
}

async function handleActionPatch(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  getPipeline: () => ReportPipeline,
): Promise<void> {
  let id: string
  try {
    id = actionIdFrom(url, '/api/actions/') ?? ''
  } catch {
    return sendJson(res, 400, { error: '行动项 id 编码非法' })
  }
  if (!id) return sendJson(res, 400, { error: '缺少行动项 id' })
  let body: ActionPatchInput
  try {
    body = JSON.parse(await readBody(req)) as ActionPatchInput
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const outcome = applyActionPatch(getPipeline().db, id, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.item)
}

async function handleManualActionCreate(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  getPipeline: () => ReportPipeline,
): Promise<void> {
  let body: ManualActionInput
  try {
    body = JSON.parse(await readBody(req)) as ManualActionInput
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const outcome = createManualAction(getPipeline().db, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.item)
}

async function handleTaskCreate(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  getPipeline: () => ReportPipeline,
): Promise<void> {
  let actionItemId: string
  try {
    actionItemId = actionIdFrom(url, '/api/actions/', '/tasks') ?? ''
  } catch {
    return sendJson(res, 400, { error: '行动项 id 编码非法' })
  }
  if (!actionItemId) return sendJson(res, 400, { error: '缺少行动项 id' })
  let body: TaskCreateInput
  try {
    body = JSON.parse(await readBody(req)) as TaskCreateInput
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const outcome = createTask(getPipeline().db, actionItemId, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.data)
}

async function handleTaskPatch(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  getPipeline: () => ReportPipeline,
): Promise<void> {
  let taskId: string
  try {
    taskId = actionIdFrom(url, '/api/tasks/') ?? ''
  } catch {
    return sendJson(res, 400, { error: '任务 id 编码非法' })
  }
  if (!taskId) return sendJson(res, 400, { error: '缺少任务 id' })
  let body: TaskPatchInput
  try {
    body = JSON.parse(await readBody(req)) as TaskPatchInput
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const outcome = patchTask(getPipeline().db, taskId, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.data)
}

async function handleFeedbackSave(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  getPipeline: () => ReportPipeline,
): Promise<void> {
  const taskId = safeDecode(url.pathname.slice('/api/tasks/'.length, -'/feedback'.length))
  if (!taskId) return sendJson(res, 400, { error: '缺少任务 id' })
  let body: FeedbackInput
  try {
    body = JSON.parse(await readBody(req)) as FeedbackInput
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const outcome = saveFeedback(getPipeline().db, taskId, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.data)
}

function handleFeedbackGet(res: ServerResponse, url: URL, getPipeline: () => ReportPipeline): void {
  const taskId = safeDecode(url.pathname.slice('/api/tasks/'.length, -'/feedback'.length))
  if (!taskId) return sendJson(res, 400, { error: '缺少任务 id' })
  const outcome = readFeedback(getPipeline().db, taskId)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.data)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}
