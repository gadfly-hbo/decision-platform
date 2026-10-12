import { existsSync, readFileSync } from 'node:fs'
import type { BoardView } from '../src/data/types'
import type { BoardDb } from './db'
import { getActionItem } from './db'
import { applyActionPatch } from './board'

/** M5 IM 集成：本模块只放平台无关纯函数（配置/卡片模型/回调处理）；飞书/钉钉 SDK 适配在各自适配器内 */

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

/* ---- 卡片模型（M5：审批对象 = 行动项；正文 = 依据 + 证据摘要 + 预期效果，契约 2.11）---- */

export interface ApprovalCard {
  /** 行动项 id：采纳/驳回按钮 payload 携带，回调据此落库 */
  itemId: string
  title: string
  rationale: string
  confidence: number | null
  evidenceLevel: string | null
  /** 证据摘要：top fact 的报告原文逐字引用（截断 ~60 字，不转写） */
  topFactQuote?: string
  /** top fact 的一句话说明 */
  topFactText?: string
  expectedImpact?: string
}

const TOP_FACT_QUOTE_CLIP = 60

function clipQuote(quote: string): string {
  return quote.length > TOP_FACT_QUOTE_CLIP ? `${quote.slice(0, TOP_FACT_QUOTE_CLIP)}…` : quote
}

/**
 * suggested 且 高优（priority=high）或证据级=数据支撑 的行动项成卡；其余走文本摘要（防审批疲劳）。
 * filter.reportId 限定单报告范围（推送漏斗按报告逐轮发卡）。
 */
export function buildApprovalCards(view: BoardView, filter: { reportId?: number } = {}): ApprovalCard[] {
  if (view.isDemo) return []
  return view.actionItems
    .filter(
      (item) =>
        item.status === 'suggested' &&
        (item.priority === 'high' || item.evidenceLevel === '数据支撑') &&
        (filter.reportId === undefined || item.reportId === filter.reportId),
    )
    .map((item) => {
      const topFact = item.evidence?.facts.find((fact) => fact.quote) ?? item.evidence?.facts[0]
      return {
        itemId: item.id,
        title: item.title,
        rationale: item.rationale,
        confidence: item.confidence,
        evidenceLevel: item.evidenceLevel,
        ...(topFact?.quote ? { topFactQuote: clipQuote(topFact.quote) } : {}),
        ...(topFact?.text ? { topFactText: topFact.text } : {}),
        expectedImpact: item.expectedImpact,
      }
    })
}

/* ---- 回调处理（payload + board.db → 回执文案；先到先得，幂等）---- */

export type ApprovalDecision = 'accept' | 'reject'

export interface ApprovalCallbackPayload {
  itemId: string
  decision: ApprovalDecision
  operatorName: string
}

export interface ApprovalCallbackOutcome {
  /** 回执文案（卡片结果态/已处理提示/无效提示） */
  reply: string
  applied: boolean
}

function isValidPayload(raw: unknown): raw is ApprovalCallbackPayload {
  if (typeof raw !== 'object' || raw === null) return false
  const it = raw as Partial<ApprovalCallbackPayload>
  return (
    typeof it.itemId === 'string' &&
    it.itemId !== '' &&
    (it.decision === 'accept' || it.decision === 'reject') &&
    typeof it.operatorName === 'string' &&
    it.operatorName !== ''
  )
}

/**
 * 卡片直审：accept→adopted / reject→dismissed（理由落默认值，看板可补填），留痕 via=card。
 * 先到先得——已决项不改库，回执提示已按首次结果处理；行动项不存在视为过期卡片。
 */
export function handleApprovalCallback(payload: unknown, args: { db: BoardDb }): ApprovalCallbackOutcome {
  if (!isValidPayload(payload)) {
    return { reply: '审批请求无效（载荷不完整）', applied: false }
  }
  const item = getActionItem(args.db, payload.itemId)
  if (!item) {
    return { reply: '该卡片已处理或已过期，请到看板查看最新状态。', applied: false }
  }
  if (item.status !== 'suggested') {
    return { reply: `已按首次点击结果处理：${item.status === 'adopted' ? '采纳' : '驳回'}`, applied: false }
  }
  const outcome = applyActionPatch(args.db, payload.itemId, {
    status: payload.decision === 'accept' ? 'adopted' : 'dismissed',
    via: 'card',
    decidedBy: payload.operatorName,
  })
  if (!outcome.ok) {
    return { reply: '审批落库失败，请重试或到看板操作', applied: false }
  }
  return { reply: `已${payload.decision === 'accept' ? '采纳' : '驳回'}：${item.title}`, applied: true }
}
