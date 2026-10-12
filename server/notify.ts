import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BoardView } from '../src/data/types'
import { buildApprovalCards, type ApprovalCard } from './im'
import { buildBoardView } from './board'
import type { ExtractResult, ReportPipeline } from './reports'
import type { ExtractionRunner } from './agent/extract'

export type NotifyPlatform = 'feishu' | 'dingtalk' | 'wecom' | 'generic'

export interface NotifyConfig {
  platform: NotifyPlatform
  url: string
}

export interface NotifyState {
  /** 已推送报告 slug 集合（T6 起数组；读取时兼容旧 lastPushedPeriod 单值并入集合） */
  pushedSlugs: string[]
}

const VALID_PLATFORMS: readonly NotifyPlatform[] = ['feishu', 'dingtalk', 'wecom', 'generic']

/** 读取推送配置；文件不存在/损坏/字段非法 → null（未配置，推送跳过） */
export function readNotifyConfig(filePath: string): NotifyConfig | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<NotifyConfig>
    if (
      typeof raw.platform === 'string' &&
      (VALID_PLATFORMS as readonly string[]).includes(raw.platform) &&
      typeof raw.url === 'string' &&
      raw.url.startsWith('http')
    ) {
      return { platform: raw.platform, url: raw.url }
    }
    console.warn('[notify] 配置格式非法，按未配置处理：', filePath)
    return null
  } catch (error) {
    console.warn('[notify] 配置读取失败，按未配置处理：', (error as Error).message)
    return null
  }
}

export function readNotifyState(filePath: string): NotifyState {
  try {
    if (!existsSync(filePath)) return { pushedSlugs: [] }
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<NotifyState> & { lastPushedPeriod?: unknown }
    const slugs = new Set<string>()
    if (Array.isArray(raw.pushedSlugs)) {
      for (const slug of raw.pushedSlugs) if (typeof slug === 'string' && slug !== '') slugs.add(slug)
    }
    // 旧结构单值兼容：视为已推过的首个 slug（幂等键语义平移，G8）
    if (typeof raw.lastPushedPeriod === 'string' && raw.lastPushedPeriod !== '') slugs.add(raw.lastPushedPeriod)
    return { pushedSlugs: [...slugs] }
  } catch {
    return { pushedSlugs: [] }
  }
}

export function writeNotifyState(filePath: string, state: NotifyState): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8')
}

export function isSlugPushed(state: NotifyState, slug: string): boolean {
  return state.pushedSlugs.includes(slug)
}

/** 发送成功后落状态（读-改-写；单机单用户并发概率极低，不引入文件锁，沿 M3 决议） */
export function markSlugPushed(stateFile: string, slug: string): void {
  const state = readNotifyState(stateFile)
  if (isSlugPushed(state, slug)) return
  writeNotifyState(stateFile, { pushedSlugs: [...state.pushedSlugs, slug] })
}

/** 最近一次成功推送的报告 slug（BoardView.notify.lastPushedReport 数据源） */
export function latestPushedSlug(state: NotifyState): string | undefined {
  return state.pushedSlugs.at(-1)
}

/** 行动闭环周摘要（M5）：本周报告 N 份、建议 X / 已采纳 Y / 已驳回 Z / 人工补充 M */
export function buildWeeklyDigest(view: BoardView): string {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const weekReports = view.reports.filter((report) => Date.parse(report.importedAt) >= weekAgo).length
  const { suggested, adopted, dismissed, manual } = view.stats
  return [
    '【决策看板】行动闭环周摘要',
    `本周报告 ${weekReports} 份 · 建议 ${suggested} / 已采纳 ${adopted} / 已驳回 ${dismissed} / 人工补充 ${manual}`,
    '打开看板确认建议、拆解任务并回录反馈。',
  ].join('\n')
}

/** 三平台 text 消息与通用裸 POST 的 payload 差异 */
export function buildNotifyPayload(platform: NotifyPlatform, text: string): unknown {
  switch (platform) {
    case 'feishu':
      return { msg_type: 'text', content: { text } }
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } }
    case 'wecom':
      return { msgtype: 'text', text: { content: text } }
    case 'generic':
      return { text }
  }
}

export async function sendNotification(config: NotifyConfig, text: string): Promise<void> {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildNotifyPayload(config.platform, text)),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`webhook 响应 ${res.status}`)
}

/** M5 IM 推送通道（飞书/钉钉桥接实现）：文本摘要 + 高优审批卡片，发给审批人单聊 */
export interface ImPushChannel {
  sendApproval(digest: string, cards: ApprovalCard[]): Promise<void>
}

export type PushFunnelReason = 'no-runner' | 'not-configured'

export interface PushFunnelResult {
  /** 本次 tick 自动抽取的结果（无 runner 时为空） */
  extracted: ExtractResult[]
  /** 本次 tick 成功推送的报告 slug（每 slug 只推一轮） */
  pushedSlugs: string[]
  reason?: PushFunnelReason
}

export interface PushFunnelArgs {
  pipeline: ReportPipeline
  /** 抽取 runner；缺席（未配置密钥等）跳过自动抽取并日志一次 */
  agentRunner: ExtractionRunner | null
  notifyFile: string
  notifyStateFile: string
  /** IM 通道优先（文本+高优卡片）；缺席回落群机器人 webhook 文本摘要 */
  imChannel?: ImPushChannel
}

let noRunnerLogged = false

/** 推送漏斗：扫描 → 自动抽取 pending/failed → 每个未推送的 done 报告发一轮（IM 文本+高优卡片 / webhook 降级） */
export async function runPushFunnel(args: PushFunnelArgs): Promise<PushFunnelResult> {
  let extracted: ExtractResult[] = []
  if (!args.agentRunner) {
    if (!noRunnerLogged) {
      noRunnerLogged = true
      console.warn('[notify] 未注入抽取 runner，跳过自动抽取（配置密钥后下轮自动补抽）')
    }
  } else {
    extracted = await args.pipeline.extract(args.agentRunner, {})
  }

  const config = readNotifyConfig(args.notifyFile)
  if (!args.imChannel && !config) return { extracted, pushedSlugs: [], reason: 'not-configured' }

  const view = buildBoardView(args.pipeline.db, { notifyConfigured: true })
  const state = readNotifyState(args.notifyStateFile)
  // 导入时间正序推送（view.reports 为倒序）；每报告 slug 只推一轮（G8 幂等）
  const unpushed = [...view.reports]
    .reverse()
    .filter((report) => report.status === 'done' && !isSlugPushed(state, report.slug))

  const pushedSlugs: string[] = []
  for (const report of unpushed) {
    const digest = buildWeeklyDigest(view)
    const cards = buildApprovalCards(view, { reportId: report.id })
    if (args.imChannel) {
      await args.imChannel.sendApproval(digest, cards)
    } else {
      await sendNotification(config!, digest)
    }
    markSlugPushed(args.notifyStateFile, report.slug)
    pushedSlugs.push(report.slug)
  }
  return { extracted, pushedSlugs }
}

/** 推送调度：启动后先扫一次（重启即补推），此后按间隔重复；返回停止函数（server.close 时调用） */
export function startPushScheduler(
  scan: () => Promise<unknown>,
  intervalMs = 60_000,
  firstDelayMs = 2_000,
): () => void {
  let stopped = false
  let first: ReturnType<typeof setTimeout> | undefined
  const tick = (): void => {
    void scan().catch((error: unknown) => {
      console.warn('[notify] 定时推送失败：', (error as Error).message)
    })
  }
  first = setTimeout(() => {
    first = undefined
    if (!stopped) tick()
  }, firstDelayMs)
  const timer = setInterval(() => {
    if (!stopped) tick()
  }, intervalMs)
  return () => {
    stopped = true
    if (first) clearTimeout(first)
    clearInterval(timer)
  }
}
