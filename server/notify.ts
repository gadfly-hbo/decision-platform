import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DashboardData } from '../src/data/types'
import type { ActionStore } from './actions'

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

export type MaybePushResult = { pushed: boolean; reason?: 'not-configured' }

/**
 * 新期次首次推送（幂等）：state.lastPushedPeriod ≥ period 则跳过；
 * 推送成功才落状态；失败上抛由调用方决定策略（自动路径记日志，手动路径 502）。
 * 已知竞态（GRILL 决议 4，明示接受）：state 为读-改-写，单机单用户下并发触发
 * 概率极低，理论上可能重复推送一次，不引入文件锁。
 */
export async function maybePushNewPeriod(args: MaybePushArgs): Promise<MaybePushResult> {
  const { config, stateFile, period, digest } = args
  if (!config) return { pushed: false, reason: 'not-configured' }
  const state = readNotifyState(stateFile)
  if (state.lastPushedPeriod >= period) return { pushed: false }
  await sendNotification(config, digest)
  writeNotifyState(stateFile, { lastPushedPeriod: period })
  return { pushed: true }
}
