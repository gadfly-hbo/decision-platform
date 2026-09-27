import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DashboardData } from '../src/data/types'
import type { ActionStore } from './actions'
import { buildDashboardData } from './dashboard'
import { readActionStore } from './actions'
import { extractPeriod } from './report/parseCsv'
import { buildApprovalCards, type ApprovalCard } from './im'

export type NotifyPlatform = 'feishu' | 'dingtalk' | 'wecom' | 'generic'

export interface NotifyConfig {
  platform: NotifyPlatform
  url: string
}

export interface NotifyState {
  lastPushedPeriod: string
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
    if (!existsSync(filePath)) return { lastPushedPeriod: '' }
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<NotifyState>
    return { lastPushedPeriod: typeof raw.lastPushedPeriod === 'string' ? raw.lastPushedPeriod : '' }
  } catch {
    return { lastPushedPeriod: '' }
  }
}

export function writeNotifyState(filePath: string, state: NotifyState): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8')
}

const SEVERITY_LABEL: Record<string, string> = { high: '【高】', medium: '【中】', low: '【低】' }

/** 周度决策摘要（GRILL 决议 1：纯文本 ≤15 行，结论先行，不带渠道明细） */
export function buildWeeklyDigest(data: DashboardData, actionStore: ActionStore): string {
  const highCount = data.conclusions.filter((c) => c.severity === 'high').length
  const lines: string[] = [
    `【决策看板】${data.period ?? ''} 周报 · 本周结论 ${data.conclusions.length} 条（高优先级 ${highCount} 条待拍板）`,
  ]
  for (const conclusion of data.conclusions.slice(0, 5)) {
    lines.push(`${SEVERITY_LABEL[conclusion.severity] ?? ''}${conclusion.title}`)
  }
  const actionIds = data.conclusions.flatMap((c) => c.actions.map((a) => a.id))
  const executed = actionIds.filter((id) => actionStore[id]?.status === 'executed').length
  const accepted = actionIds.filter((id) => actionStore[id]?.status === 'accepted').length
  lines.push(`建议行动 ${actionIds.length} 项（已采纳 ${accepted} · 已执行 ${executed}）`)
  lines.push('打开看板查看推导与归因，直接拍板。')
  return lines.join('\n')
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

export interface MaybePushArgs {
  config: NotifyConfig | null
  stateFile: string
  period: string
  digest: string
}

export type MaybePushResult = { pushed: boolean; reason?: 'not-configured' | 'no-period' }

/** M4 IM 推送通道（飞书/钉钉桥接实现）：文本摘要 + 高优审批卡片，发给审批人单聊 */
export interface ImPushChannel {
  sendApproval(digest: string, cards: ApprovalCard[]): Promise<void>
}

/**
 * 新期次首次推送（幂等）：state.lastPushedPeriod ≥ period 则跳过；
 * 推送成功才落状态；失败上抛由调用方决定策略（自动路径记日志，手动路径 502）。
 * 已知竞态（M3 GRILL 自答、M4 PRD 决议 3 沿用，明示接受）：state 为读-改-写，单机单用户下并发触发
 * 概率极低，理论上可能重复推送一次，不引入文件锁。
 */
/** 幂等门核心：state ≥ period 跳过；发送成功才落状态，失败上抛（M4 起由 webhook 与 IM 通道共用） */
export async function pushPeriodIdempotent(args: {
  send: () => Promise<void>
  stateFile: string
  period: string
}): Promise<MaybePushResult> {
  const { send, stateFile, period } = args
  const state = readNotifyState(stateFile)
  if (state.lastPushedPeriod >= period) return { pushed: false }
  await send()
  writeNotifyState(stateFile, { lastPushedPeriod: period })
  return { pushed: true }
}

export async function maybePushNewPeriod(args: MaybePushArgs): Promise<MaybePushResult> {
  const { config, stateFile, period, digest } = args
  if (!config) return { pushed: false, reason: 'not-configured' }
  return pushPeriodIdempotent({ send: () => sendNotification(config, digest), stateFile, period })
}

/* ---- M4a：定时扫描推送（红队 KA1：推送不依赖任何人打开看板）---- */

/** 目录内最新 CSV 期次（只读文件名，轻量）；无 CSV/目录缺失 → null */
export function latestPeriodInDir(dataDir: string): string | null {
  let latest: string | null = null
  try {
    for (const name of readdirSync(dataDir)) {
      if (!name.endsWith('.csv')) continue
      const period = extractPeriod(name)
      if (period && (!latest || period > latest)) latest = period
    }
  } catch {
    return null
  }
  return latest
}

export interface ScanPushArgs {
  dataDir: string
  actionsFile: string
  notifyFile: string
  notifyStateFile: string
  /** M4：IM 通道优先（配置了桥接即用应用消息+卡片，不再走群机器人） */
  imChannel?: ImPushChannel
}

/** 扫描一次：目录出现新期次即构建+幂等推送；IM 通道（文本+高优卡片）优先于群机器人 webhook */
export async function scanAndPush(args: ScanPushArgs): Promise<MaybePushResult> {
  const config = readNotifyConfig(args.notifyFile)
  const period = latestPeriodInDir(args.dataDir)
  if (!period) return { pushed: false, reason: 'no-period' }
  if (readNotifyState(args.notifyStateFile).lastPushedPeriod >= period) return { pushed: false }
  if (!args.imChannel && !config) return { pushed: false, reason: 'not-configured' }
  const data = buildDashboardData(args.dataDir, { actionsFile: args.actionsFile })
  if (data.isDemo || !data.period) return { pushed: false }
  const digest = buildWeeklyDigest(data, readActionStore(args.actionsFile))
  const send = args.imChannel
    ? () => args.imChannel!.sendApproval(digest, buildApprovalCards(data))
    : () => sendNotification(config!, digest)
  return pushPeriodIdempotent({ send, stateFile: args.notifyStateFile, period: data.period })
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
