import { createServer, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  readNotifyConfig,
  readNotifyState,
  latestPushedSlugOfProject,
  markSlugPushed,
  projectPushKey,
  buildProjectDigest,
  pushProjectReport,
  sendNotification,
  type ImPushChannel,
} from './notify'
import { readImConfig, buildApprovalCards } from './im'
import { startFeishuBridge } from './im-feishu'
import { composeDefaultAgent } from './agent/compose'
import type { ExtractionRunner } from './agent/extract'
import type { BoardView } from '../src/data/types'
import {
  createProject,
  deleteProject,
  getProject,
  getReportBySlug,
  listProjects,
  openBoardDb,
  projectActionCounts,
  projectLastActivity,
  updateProject,
  updateReportStatus,
  upsertReport,
  type BoardDb,
} from './db'
import { extractReports, scanReports } from './reports'
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
  /** 推送配置文件（默认 <项目根>/data/notify.json） */
  notifyFile?: string
  /** 推送幂等状态文件（默认 <项目根>/data/notify-state.json） */
  notifyStateFile?: string
  /** 前端构建产物目录（默认 <项目根>/dist）；存在时非 API GET 走静态服务 */
  distDir?: string
  /** IM 推送通道（飞书桥接）；缺席时推送回落群机器人 webhook */
  imChannel?: ImPushChannel
  /** M6：SQLite 库路径（默认 <项目根>/data/board.db）；M5 旧库自动删文件重建 */
  dbPath?: string
  /** M6：共享库实例注入（生产 boot 与飞书桥接共用同一连接）；缺省按 dbPath 惰性打开 */
  db?: BoardDb
  /** M6：项目根目录（默认 <项目根>/data/projects）；每项目 reports 子目录为 <dir>/<projectId>/reports/ */
  projectsDir?: string
  /** M5：抽取 runner 注入（测试用假 runner / 生产 composeDefaultAgent）；缺席时抽取能力不可用 */
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
    const report = event.taskId.split(':').slice(2).join(':') || event.taskId // taskId = extract:<projectId>:<slug>
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

/** 项目列表聚合条目（GET /api/projects 响应形状） */
interface ProjectSummaryView {
  id: string
  title: string
  purpose: string
  createdAt: string
  updatedAt: string
  actionCounts: { suggested: number; adopted: number; dismissed: number; manual: number }
  lastActivity: string
}

/**
 * M6 项目化服务：项目 CRUD + 项目 board + 行动闭环端点（item 全局 id，归属经数据隔离）。
 * M5 的 GET /api/dashboard、全局 /api/reports* 与调度器已移除（报告入口片 2 上传端点接入）。
 */
export function startServer(
  port: number = DEFAULT_PORT,
  host = '127.0.0.1',
  options: ServerOptions = {},
): Server {
  const notifyFile = options.notifyFile ?? join(process.cwd(), 'data', 'notify.json')
  const notifyStateFile = options.notifyStateFile ?? join(process.cwd(), 'data', 'notify-state.json')
  const distDir = options.distDir ?? join(process.cwd(), 'dist')
  const agentAuditPath = options.agentAuditPath ?? join(process.cwd(), 'data', 'agent-audit.jsonl')
  const projectsDir = options.projectsDir ?? join(process.cwd(), 'data', 'projects')
  // 共享单库（进程一个库文件）；M5 旧库在首次打开时自动删文件重建
  let db: BoardDb | null = options.db ?? null
  const getDb = (): BoardDb => {
    if (!db) db = openBoardDb(options.dbPath ?? join(process.cwd(), 'data', 'board.db'))
    return db
  }
  const projectDir = (projectId: string) => join(projectsDir, projectId)
  const projectReportsDir = (projectId: string) => join(projectDir(projectId), 'reports')
  /** 抽取统一入口：成功（done）后事件驱动推送（inserted>0 才推；PRD「有新行动项」） */
  /** 上传后异步触发抽取（不阻塞上传响应）：无 runner → 报告落 failed「模型不可用」 */
  const triggerExtract = (projectId: string, slug: string, force: boolean): void => {
    const runner = options.agentRunner
    void (async () => {
      if (!runner) {
        const report = getReportBySlug(getDb(), projectId, slug)
        if (report) updateReportStatus(getDb(), report.id, 'failed', '模型不可用：未注入抽取 runner（未配置密钥或服务未装配）')
        return
      }
      await extractReports(getDb(), projectId, projectReportsDir(projectId), runner, {
        slug,
        ...(force ? { force: true } : {}),
        onReportDone: ({ slug: doneSlug, inserted }) => {
          if (inserted > 0) {
            void pushProjectReport({
              db: getDb(),
              projectId,
              slug: doneSlug,
              notifyFile,
              notifyStateFile,
              ...(options.imChannel ? { imChannel: options.imChannel } : {}),
            })
          }
        },
      })
    })().catch((error: unknown) => {
      console.warn('[reports] 异步抽取失败：', (error as Error).message)
    })
  }

  const runProjectExtract = (projectId: string, extractOptions: { slug?: string; force?: boolean } = {}) => {
    const runner = options.agentRunner
    if (!runner) {
      return Promise.reject(new Error('模型不可用：未注入抽取 runner（未配置密钥或服务未装配），请检查 ~/.pi/agent/auth.json 或环境变量'))
    }
    return extractReports(getDb(), projectId, projectReportsDir(projectId), runner, {
      ...extractOptions,
      onReportDone: ({ slug, inserted }) => {
        // 事件驱动推送（G3'）：done 且有新行动项才推；失败在 pushProjectReport 内记日志不阻塞
        if (inserted > 0) {
          void pushProjectReport({
            db: getDb(),
            projectId,
            slug,
            notifyFile,
            notifyStateFile,
            ...(options.imChannel ? { imChannel: options.imChannel } : {}),
          })
        }
      },
    })
  }
  const notifyConfigured = (): boolean => readNotifyConfig(notifyFile) !== null || Boolean(options.imChannel)
  const projectSummaries = (): ProjectSummaryView[] =>
    listProjects(getDb()).map((project) => ({
      ...project,
      actionCounts: projectActionCounts(getDb(), project.id),
      lastActivity: projectLastActivity(getDb(), project.id),
    }))
  const loadProjectBoard = (projectId: string): BoardView | null => {
    // 评审修复 2：board 加载先扫描——extracting 自愈（非本进程在抽的遗留复位 failed；scanReports 内含
    // inFlight 守卫不误伤同进程进行中的抽取）+ 目录新文件幂等注册
    scanReports(getDb(), projectId, projectReportsDir(projectId))
    const view = buildBoardView(getDb(), projectId, {
      notifyConfigured: notifyConfigured(),
      imConfigured: Boolean(options.imChannel),
      lastPushedReport: latestPushedSlugOfProject(readNotifyState(notifyStateFile), projectId),
    })
    return view
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
    const guard = (promise: Promise<void>): void => {
      void promise.catch((error: unknown) => {
        console.error('[server] 处理器异常：', error)
        if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message })
      })
    }
    // ---- M6：项目报告入口（上传/抽取）----
    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/reports/extract')) {
      const projectId = safeDecode(url.pathname.slice('/api/projects/'.length, -'/reports/extract'.length))
      return guard(handleProjectExtract(req, res, { getDb, projectId, runProjectExtract }))
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/projects/') && url.pathname.endsWith('/reports')) {
      const projectId = safeDecode(url.pathname.slice('/api/projects/'.length, -'/reports'.length))
      return guard(handleProjectUpload(req, res, { getDb, projectId, reportsDir: projectReportsDir(projectId), triggerExtract }))
    }
    // ---- M6：项目 CRUD ----
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      return guard(handleProjectCreate(req, res, getDb))
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      return sendJson(res, 200, { projects: projectSummaries() })
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(\/board)?$/)
    if (projectMatch && !projectMatch[2]) {
      const projectId = safeDecode(projectMatch[1])
      if (req.method === 'PATCH') {
        return guard(handleProjectPatch(req, res, getDb, projectId))
      }
      if (req.method === 'DELETE') {
        return handleProjectDelete(res, getDb, projectId, projectDir(projectId))
      }
      if (req.method === 'GET') {
        const project = getProject(getDb(), projectId)
        if (!project) return sendJson(res, 404, { error: `项目不存在：${projectId}` })
        return sendJson(res, 200, project)
      }
    }
    if (projectMatch?.[2] && req.method === 'GET') {
      const projectId = safeDecode(projectMatch[1])
      const view = loadProjectBoard(projectId)
      if (!view) return sendJson(res, 404, { error: `项目不存在：${projectId}` })
      return sendJson(res, 200, view)
    }
    // ---- 账本/审计投影（S-R 运行详情；全局账本不随项目化拆分） ----
    if (req.method === 'GET' && url.pathname === '/api/agent/usage') {
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
    // ---- 行动闭环（item 全局 id；board 聚合保证项目隔离） ----
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/actions/')) {
      return guard(handleActionPatch(req, res, url, getDb))
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/actions/')) {
      let id: string
      try {
        id = actionIdFrom(url, '/api/actions/') ?? ''
      } catch {
        return sendJson(res, 400, { error: '行动项 id 编码非法' })
      }
      if (!id) return sendJson(res, 400, { error: '缺少行动项 id' })
      const outcome = removeActionItem(getDb(), id)
      if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
      return sendJson(res, 200, { deleted: true, id })
    }
    if (req.method === 'POST' && url.pathname === '/api/actions') {
      return guard(handleManualActionCreate(req, res, getDb))
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/actions/') && url.pathname.endsWith('/tasks')) {
      return guard(handleTaskCreate(req, res, url, getDb))
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) {
      return guard(handleTaskPatch(req, res, url, getDb))
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/feedback')) {
      return guard(handleFeedbackSave(req, res, url, getDb))
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/') && url.pathname.endsWith('/feedback')) {
      return handleFeedbackGet(res, url, getDb)
    }
    // ---- 推送 ----
    if (req.method === 'POST' && url.pathname === '/api/notify/push') {
      return guard(handleNotifyPush(req, res, { getDb, loadProjectBoard, notifyFile, notifyStateFile, imChannel: options.imChannel }))
    }
    if (req.method === 'POST' && url.pathname === '/api/notify/test') {
      return guard(handleNotifyTest(res, notifyFile, options.imChannel))
    }
    if (req.method === 'GET' && url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return serveStatic(res, distDir, url.pathname)
    }
    sendJson(res, 404, { error: 'not found' })
  })
  server.on('close', () => {
    if (db && !options.db) closeDbQuietly(db) // 注入的库由注入方管理生命周期
    db = null
  })
  server.listen(port, host)
  return server
}

function closeDbQuietly(db: BoardDb): void {
  try {
    db.close()
  } catch {
    // 关闭异常不阻塞 server.close 回调
  }
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
  // 生产：共享单库（服务器与飞书桥接同连接）；M5 旧库自动清空重建
  const db = openBoardDb(join(process.cwd(), 'data', 'board.db'))
  const projectsDir = join(process.cwd(), 'data', 'projects')
  // 配置了飞书（data/im.json）→ 长连接桥接（零公网入站）；无配置跳过，推送回落群机器人
  let imChannel: ImPushChannel | undefined
  let stopBridge: (() => Promise<void>) | undefined
  const imConf = readImConfig(join(process.cwd(), 'data', 'im.json'))
  const feishuConf = imConf?.platforms.find((p) => p.platform === 'feishu')
  if (feishuConf) {
    try {
      const bridge = await startFeishuBridge({ config: feishuConf, db })
      imChannel = bridge
      stopBridge = () => bridge.stop()
      console.log('[im:feishu] 长连接桥接已启动（审批卡片就绪）')
    } catch (error) {
      console.warn('[im:feishu] 桥接启动失败，推送回落群机器人文本摘要：', (error as Error).message)
    }
  }
  // M5：生产装配抽取 runner（密钥缺失降级，不阻塞看板其他能力）；账本实例供 S-R 运行详情投影
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
    console.warn('[agent] 模型链不可用，抽取能力将不可用：', (error as Error).message)
  }
  const server = startServer(port, host, {
    db,
    projectsDir,
    ...(imChannel ? { imChannel } : {}),
    ...(agentRunner ? { agentRunner } : {}),
    ...(agentLedger ? { agentLedger } : {}),
    ...(agentAuditPath ? { agentAuditPath } : {}),
  })
  if (stopBridge) server.on('close', () => void stopBridge!())
  console.log(`[decision-platform] backend listening on http://${host}:${port}`)
}

// ---- M6：项目报告入口（上传/抽取）----

const MAX_REPORT_BYTES = 2 * 1024 * 1024
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

interface UploadFileOutcome {
  filename: string
  slug?: string
  ok: boolean
  status: 'accepted' | 'failed'
  error?: string
}

/** 单文件校验+解码：文件名（.md/.txt、无路径分隔）、base64、≤2MB、UTF-8 可解码（拒绝 U+FFFD 替换） */
function decodeUploadFile(raw: unknown): { ok: true; filename: string; content: string } | { ok: false; filename: string; error: string } {
  const filename = typeof (raw as { filename?: unknown })?.filename === 'string' ? (raw as { filename: string }).filename.trim() : ''
  if (filename === '') return { ok: false, filename, error: '文件名必填' }
  if (!/\.(md|txt)$/i.test(filename)) return { ok: false, filename, error: '仅支持 .md/.txt 报告' }
  if (/[/\\]/.test(filename) || filename.includes('..')) return { ok: false, filename, error: '文件名不可含路径分隔符' }
  const contentBase64 = (raw as { contentBase64?: unknown }).contentBase64
  if (typeof contentBase64 !== 'string' || contentBase64.trim() === '') return { ok: false, filename, error: '缺少文件内容（contentBase64）' }
  const normalized = contentBase64.replace(/\s+/g, '')
  if (normalized.length % 4 !== 0 || !BASE64_RE.test(normalized)) return { ok: false, filename, error: 'contentBase64 不是合法 base64' }
  const buffer = Buffer.from(normalized, 'base64')
  if (buffer.byteLength === 0) return { ok: false, filename, error: '文件内容为空' }
  if (buffer.byteLength > MAX_REPORT_BYTES) return { ok: false, filename, error: `文件超过 2MB 上限（${buffer.byteLength} 字节）` }
  const content = buffer.toString('utf-8')
  if (content.includes('\uFFFD')) return { ok: false, filename, error: '内容无法按 UTF-8 解码（检测到二进制/损坏编码）' }
  return { ok: true, filename, content }
}

interface ProjectUploadDeps {
  getDb: () => BoardDb
  projectId: string
  reportsDir: string
  triggerExtract(projectId: string, slug: string, force: boolean): void
}

function slugOf(filename: string): string {
  return filename
    .replace(/\.(md|txt)$/i, '')
    .replace(/[\s/\\]+/g, '-')
    .trim()
}

async function handleProjectUpload(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  deps: ProjectUploadDeps,
): Promise<void> {
  if (!deps.projectId) return sendJson(res, 400, { error: '缺少项目 id' })
  const db = deps.getDb()
  if (!getProject(db, deps.projectId)) return sendJson(res, 404, { error: `项目不存在：${deps.projectId}` })
  let body: { files?: unknown; filename?: unknown; contentBase64?: unknown }
  try {
    body = JSON.parse((await readBody(req)) || '{}') as typeof body
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  // 多文件（files 数组）或单文件（{filename, contentBase64}）兼容；两者皆缺 → 400
  const hasFilesArray = Array.isArray(body.files)
  const hasSingleShape = typeof body.filename === 'string' || typeof body.contentBase64 === 'string'
  if (!hasFilesArray && !hasSingleShape) return sendJson(res, 400, { error: '缺少文件（files 数组或单文件字段）' })
  const files = hasFilesArray ? (body.files as unknown[]) : [body]
  if (files.length === 0) return sendJson(res, 400, { error: '缺少文件（files 数组为空）' })

  const results: UploadFileOutcome[] = []
  for (const raw of files) {
    const decoded = decodeUploadFile(raw)
    if (!decoded.ok) {
      results.push({ filename: decoded.filename || '(未命名)', ok: false, status: 'failed', error: decoded.error })
      continue
    }
    const slug = slugOf(decoded.filename)
    // 落盘（目录递归建）→ 注册 pending；同名已存在（任何状态）一律 force 重抽（评审修复 1：
    // 覆盖 failed 遗留与 extracting 中断场景，G3 保护已决项 + 清理旧 suggested 不留残骸）
    mkdirSync(deps.reportsDir, { recursive: true })
    writeFileSync(join(deps.reportsDir, decoded.filename), decoded.content, 'utf-8')
    const existing = getReportBySlug(db, deps.projectId, slug)
    const force = existing !== undefined
    if (existing) {
      updateReportStatus(db, existing.id, 'pending')
    } else {
      upsertReport(db, deps.projectId, { slug, filename: decoded.filename })
    }
    deps.triggerExtract(deps.projectId, slug, force)
    results.push({ filename: decoded.filename, slug, ok: true, status: 'accepted' })
  }
  sendJson(res, 200, { results })
}

interface ProjectExtractDeps {
  getDb: () => BoardDb
  projectId: string
  runProjectExtract(projectId: string, options: { slug?: string; force?: boolean }): Promise<import('./reports').ExtractResult[]>
}

async function handleProjectExtract(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  deps: ProjectExtractDeps,
): Promise<void> {
  if (!deps.projectId) return sendJson(res, 400, { error: '缺少项目 id' })
  if (!getProject(deps.getDb(), deps.projectId)) return sendJson(res, 404, { error: `项目不存在：${deps.projectId}` })
  let body: { slug?: unknown; force?: unknown }
  try {
    body = JSON.parse((await readBody(req)) || '{}') as typeof body
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const slug = typeof body.slug === 'string' && body.slug !== '' ? body.slug : undefined
  try {
    const results = await deps.runProjectExtract(deps.projectId, { slug, ...(body.force === true ? { force: true } : {}) })
    return sendJson(res, 200, { results })
  } catch (error) {
    if (/模型不可用/.test((error as Error).message)) {
      return sendJson(res, 503, { error: (error as Error).message })
    }
    throw error
  }
}

// ---- M6：项目路由处理器 ----

async function handleProjectCreate(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  getDb: () => BoardDb,
): Promise<void> {
  let body: { title?: unknown; purpose?: unknown }
  try {
    body = JSON.parse((await readBody(req)) || '{}') as typeof body
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return sendJson(res, 400, { error: '项目名称必填' })
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : ''
  const project = createProject(getDb(), { title, purpose })
  sendJson(res, 201, project)
}

async function handleProjectPatch(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  getDb: () => BoardDb,
  projectId: string,
): Promise<void> {
  if (!projectId) return sendJson(res, 400, { error: '缺少项目 id' })
  let body: { title?: unknown; purpose?: unknown }
  try {
    body = JSON.parse((await readBody(req)) || '{}') as typeof body
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim() === '')) {
    return sendJson(res, 400, { error: '项目名称不可为空' })
  }
  const patch: { title?: string; purpose?: string } = {}
  if (typeof body.title === 'string') patch.title = body.title.trim()
  if (typeof body.purpose === 'string') patch.purpose = body.purpose.trim()
  const updated = updateProject(getDb(), projectId, patch)
  if (!updated) return sendJson(res, 404, { error: `项目不存在：${projectId}` })
  sendJson(res, 200, updated)
}

function handleProjectDelete(res: ServerResponse, getDb: () => BoardDb, projectId: string, dir: string): void {
  if (!projectId) return sendJson(res, 400, { error: '缺少项目 id' })
  const deleted = deleteProject(getDb(), projectId) // 外键级联清 reports/items/tasks/feedback
  if (!deleted) return sendJson(res, 404, { error: `项目不存在：${projectId}` })
  try {
    rmSync(dir, { recursive: true, force: true }) // force：目录不存在容忍
  } catch (error) {
    console.warn('[projects] 报告目录删除失败（库已清理）：', (error as Error).message)
  }
  sendJson(res, 200, { deleted: true, id: projectId })
}

// ---- 推送 ----

interface NotifyPushDeps {
  getDb: () => BoardDb
  loadProjectBoard: (projectId: string) => BoardView | null
  notifyFile: string
  notifyStateFile: string
  imChannel?: ImPushChannel
}

async function handleNotifyPush(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  deps: NotifyPushDeps,
): Promise<void> {
  const config = readNotifyConfig(deps.notifyFile)
  const imChannel = deps.imChannel
  if (!config && !imChannel) return sendJson(res, 400, { error: '未配置推送（data/notify.json 或 data/im.json）' })
  let body: { projectId?: unknown; slug?: unknown }
  try {
    body = JSON.parse((await readBody(req)) || '{}') as typeof body
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  // 项目解析：body.projectId 指定；缺省取最近活跃项目（updated_at 最新）
  const db = deps.getDb()
  const projects = listProjects(db)
  const projectId =
    typeof body.projectId === 'string' && body.projectId !== ''
      ? body.projectId
      : projects[0]?.id
  if (!projectId || !getProject(db, projectId)) {
    return sendJson(res, 404, { error: '项目不存在（或库内无项目），无法推送' })
  }
  const view = deps.loadProjectBoard(projectId)
  if (!view) return sendJson(res, 404, { error: `项目不存在：${projectId}` })
  const doneReports = view.reports.filter((report) => report.status === 'done')
  // 手动重推 = 补救语义：指定 slug 真发该报告一轮；缺省取项目最新 done 报告；无 done 拒绝
  const bodySlug = typeof body.slug === 'string' && body.slug !== '' ? body.slug : undefined
  const target = bodySlug ? doneReports.find((report) => report.slug === bodySlug) : doneReports[0]
  if (!target) {
    if (bodySlug && view.reports.some((report) => report.slug === bodySlug)) {
      return sendJson(res, 400, { error: `报告未抽取完成，无法推送：${bodySlug}` })
    }
    if (bodySlug) return sendJson(res, 404, { error: `报告不存在：${bodySlug}` })
    return sendJson(res, 400, { error: '项目内无已抽取完成的报告，无法推送' })
  }
  try {
    const digest = buildProjectDigest(view) // 【项目名】+ 行动摘要（与自动推送同口径）
    if (imChannel) {
      await imChannel.sendApproval(digest, buildApprovalCards(view, { reportId: target.id }))
    } else {
      await sendNotification(config!, digest)
    }
    markSlugPushed(deps.notifyStateFile, projectPushKey(projectId, target.slug))
    sendJson(res, 200, { pushed: true, projectId, period: target.slug })
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

// ---- M5：行动闭环路由处理器（item 全局 id，项目隔离由 board 聚合保证）----

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
  getDb: () => BoardDb,
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
  const outcome = applyActionPatch(getDb(), id, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.item)
}

async function handleManualActionCreate(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  getDb: () => BoardDb,
): Promise<void> {
  let body: ManualActionInput
  try {
    body = JSON.parse(await readBody(req)) as ManualActionInput
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId : ''
  if (!projectId) return sendJson(res, 400, { error: '缺少项目 id' })
  const outcome = createManualAction(getDb(), projectId, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.item)
}

async function handleTaskCreate(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  getDb: () => BoardDb,
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
  const outcome = createTask(getDb(), actionItemId, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.data)
}

async function handleTaskPatch(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  getDb: () => BoardDb,
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
  const outcome = patchTask(getDb(), taskId, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.data)
}

async function handleFeedbackSave(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  getDb: () => BoardDb,
): Promise<void> {
  const taskId = safeDecode(url.pathname.slice('/api/tasks/'.length, -'/feedback'.length))
  if (!taskId) return sendJson(res, 400, { error: '缺少任务 id' })
  let body: FeedbackInput
  try {
    body = JSON.parse(await readBody(req)) as FeedbackInput
  } catch {
    return sendJson(res, 400, { error: '请求体必须是 JSON' })
  }
  const outcome = saveFeedback(getDb(), taskId, body)
  if (!outcome.ok) return sendJson(res, outcome.status, { error: outcome.error })
  sendJson(res, 200, outcome.data)
}

function handleFeedbackGet(res: ServerResponse, url: URL, getDb: () => BoardDb): void {
  const taskId = safeDecode(url.pathname.slice('/api/tasks/'.length, -'/feedback'.length))
  if (!taskId) return sendJson(res, 400, { error: '缺少任务 id' })
  const outcome = readFeedback(getDb(), taskId)
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
