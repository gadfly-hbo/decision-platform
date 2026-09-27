import { existsSync, readFileSync } from 'node:fs'
import type { DashboardData } from '../src/data/types'
import { updateActionRecord, type ActionStore } from './actions'

/** M4 IM 集成：本模块只放平台无关纯函数（配置/卡片模型/回调处理）；飞书/钉钉 SDK 适配在各自适配器内 */

export type ImPlatform = 'feishu' | 'dingtalk'

export interface ImPlatformConfig {
  platform: ImPlatform
  appId: string
  appSecret: string
  /** 平台侧审批人用户标识（飞书 open_id/user_id、钉钉 userId） */
  approverUserId: string
  /** 审批人显示名（卡片结果态与 decidedBy 留痕用） */
  approverName: string
}

export interface ImConfig {
  platforms: ImPlatformConfig[]
}

const IM_PLATFORMS: readonly ImPlatform[] = ['feishu', 'dingtalk']

function isImPlatformConfig(raw: unknown): raw is ImPlatformConfig {
  if (typeof raw !== 'object' || raw === null) return false
  const it = raw as Partial<ImPlatformConfig>
  return (
    typeof it.platform === 'string' &&
    (IM_PLATFORMS as readonly string[]).includes(it.platform) &&
    typeof it.appId === 'string' &&
    it.appId !== '' &&
    typeof it.appSecret === 'string' &&
    it.appSecret !== '' &&
    typeof it.approverUserId === 'string' &&
    it.approverUserId !== '' &&
    typeof it.approverName === 'string' &&
    it.approverName !== ''
  )
}

/** 读取 IM 配置；文件不存在/损坏/字段非法 → null（未配置，卡片推送跳过，沿 notify.json 惯例） */
export function readImConfig(filePath: string): ImConfig | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { platforms?: unknown }
    if (!Array.isArray(raw.platforms) || raw.platforms.length === 0) {
      console.warn('[im] 配置 platforms 为空，按未配置处理：', filePath)
      return null
    }
    if (!raw.platforms.every(isImPlatformConfig)) {
      console.warn('[im] 配置字段非法，按未配置处理：', filePath)
      return null
    }
    return { platforms: raw.platforms }
  } catch (error) {
    console.warn('[im] 配置读取失败，按未配置处理：', (error as Error).message)
    return null
  }
}

/* ---- 卡片模型（KA5：无【详情】跳转，卡片必须自解释）---- */

export interface ApprovalCardAction {
  actionId: string
  text: string
  impact: string
}

export interface ApprovalAttribution {
  dimension: string
  contribution: number
  delta?: string
}

export interface ApprovalCard {
  conclusionId: string
  severity: string
  title: string
  /** 结论全文（决策依据） */
  summary: string
  window: string
  period: string
  /** 归因 top 渠道（按 |贡献| 降序 ≤3 行） */
  attribution: ApprovalAttribution[]
  /** 每个行动一组【采纳】【驳回】按钮（当前规则引擎每结论 1 条行动） */
  actions: ApprovalCardAction[]
}

/** 仅 high 且带建议行动的结论成卡；medium/low 与无行动结论走文本摘要 */
export function buildApprovalCards(data: DashboardData): ApprovalCard[] {
  if (data.isDemo || !data.period) return []
  const cards: ApprovalCard[] = []
  for (const conclusion of data.conclusions) {
    if (conclusion.severity !== 'high' || conclusion.actions.length === 0) continue
    cards.push({
      conclusionId: conclusion.id,
      severity: conclusion.severity,
      title: conclusion.title,
      summary: conclusion.summary,
      window: conclusion.window,
      period: data.period,
      attribution: [...conclusion.breakdown]
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 3)
        .map((row) => ({
          dimension: row.dimension,
          contribution: row.contribution,
          ...(row.delta !== undefined ? { delta: row.delta } : {}),
        })),
      actions: conclusion.actions.map((a) => ({ actionId: a.id, text: a.text, impact: a.impact })),
    })
  }
  return cards
}

/* ---- 回调处理（纯函数：载荷 + store → 新 store + 回执文案）---- */

export type ApprovalDecision = 'accept' | 'reject'

export interface ApprovalCallbackPayload {
  conclusionId: string
  actionId: string
  decision: ApprovalDecision
  operatorName: string
  /** 卡片推送时的期次（时效校验：落后当前期次即过期，proposal §8） */
  period: string
}

export interface ApprovalCallbackOutcome {
  store: ActionStore
  /** 回执文案（卡片结果态/已处理提示/无效提示） */
  reply: string
  applied: boolean
}

const STATUS_LABEL: Record<string, string> = { accepted: '已采纳', rejected: '已驳回', executed: '已执行' }

function isValidPayload(raw: unknown): raw is ApprovalCallbackPayload {
  if (typeof raw !== 'object' || raw === null) return false
  const it = raw as Partial<ApprovalCallbackPayload>
  return (
    typeof it.conclusionId === 'string' &&
    it.conclusionId !== '' &&
    typeof it.actionId === 'string' &&
    it.actionId !== '' &&
    (it.decision === 'accept' || it.decision === 'reject') &&
    typeof it.operatorName === 'string' &&
    it.operatorName !== '' &&
    typeof it.period === 'string' &&
    it.period !== ''
  )
}

/**
 * 审批回调：accept→accepted / reject→rejected，留痕 via=card。
 * 期次校验先行：卡片期次落后当前期次 → 过期回执不落库（proposal §8）；
 * 先到先得——记录已非 pending（含 PC 渠道）不改 store，回执提示已处理（对平台重试天然幂等）；
 * 记录不存在视为 pending（行动默认态），可审。
 */
export function handleApprovalCallback(
  payload: unknown,
  args: { store: ActionStore; period: string; currentPeriod: string; now: string },
): ApprovalCallbackOutcome {
  if (!isValidPayload(payload)) {
    return { store: args.store, reply: '审批请求无效（载荷不完整）', applied: false }
  }
  const { actionId, decision, operatorName, period } = payload
  if (period !== args.currentPeriod) {
    return {
      store: args.store,
      reply: `该卡片已过期（期次 ${period}，当前 ${args.currentPeriod || '未知'}），请在最新一期推送中审批`,
      applied: false,
    }
  }
  const existing = args.store[actionId]
  if (existing && existing.status !== 'pending') {
    const who = existing.decidedBy ?? 'PC'
    return {
      store: args.store,
      reply: `该决策已处理：${STATUS_LABEL[existing.status] ?? existing.status}（${who}），无需重复操作`,
      applied: false,
    }
  }
  const status = decision === 'accept' ? 'accepted' : 'rejected'
  const store = updateActionRecord(
    args.store,
    actionId,
    { status, decidedBy: operatorName, decidedVia: 'card' },
    existing?.period ?? args.period,
    args.now,
  )
  return { store, reply: `已${decision === 'accept' ? '采纳' : '驳回'} · ${operatorName} · ${args.now}`, applied: true }
}
