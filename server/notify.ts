import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BoardView } from '../src/data/types'
import { buildApprovalCards, type ApprovalCard } from './im'
import { buildBoardView } from './board'
import type { BoardDb } from './db'

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

/** M6 推送幂等键：projectId:slug（同 slug 跨项目互不影响） */
export function projectPushKey(projectId: string, slug: string): string {
  return `${projectId}:${slug}`
}

/** 项目最近一次成功推送的报告 slug（BoardView.notify.lastPushedReport 数据源；取键的 slug 段） */
export function latestPushedSlugOfProject(state: NotifyState, projectId: string): string | undefined {
  const prefix = `${projectId}:`
  for (let i = state.pushedSlugs.length - 1; i >= 0; i--) {
    const key = state.pushedSlugs[i]
    if (key.startsWith(prefix)) return key.slice(prefix.length)
  }
  return undefined
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

/** 行动闭环摘要：项目版 = 【项目名】 + M5 行动摘要文本（手动重推与自动推送共用口径） */
export function buildProjectDigest(view: BoardView): string {
  return `【${view.project.title}】\n${buildWeeklyDigest(view)}`
}

export interface ProjectPushArgs {
  db: BoardDb
  projectId: string
  slug: string
  notifyFile: string
  notifyStateFile: string
  imChannel?: ImPushChannel
}

/**
 * 抽取完成事件驱动推送（M6-T2，G3'：替代已退役的全局调度器）：每 projectId:slug 一轮（幂等）；
 * 无通道配置跳过；发送失败记日志不上抛——推送是旁路，不阻塞抽取状态。
 */
export async function pushProjectReport(args: ProjectPushArgs): Promise<void> {
  try {
    const config = readNotifyConfig(args.notifyFile)
    if (!args.imChannel && !config) return
    const key = projectPushKey(args.projectId, args.slug)
    if (isSlugPushed(readNotifyState(args.notifyStateFile), key)) return
    const view = buildBoardView(args.db, args.projectId, { notifyConfigured: true })
    if (!view) return
    const report = view.reports.find((it) => it.slug === args.slug && it.status === 'done')
    if (!report) return
    const digest = buildProjectDigest(view)
    if (args.imChannel) {
      await args.imChannel.sendApproval(digest, buildApprovalCards(view, { reportId: report.id }))
    } else {
      await sendNotification(config!, digest)
    }
    markSlugPushed(args.notifyStateFile, key)
  } catch (error) {
    console.warn('[notify] 抽取完成推送失败（不阻塞抽取状态）：', (error as Error).message)
  }
}

/* M6 G3'：startPushScheduler 调度器与全局扫描漏斗随项目化退役；推送由抽取完成处事件驱动（pushProjectReport）。 */
