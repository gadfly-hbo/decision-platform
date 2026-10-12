/**
 * M5 飞书适配器：LarkChannel 长连接（零公网入站，前置门实测通过 2026-09-27）。
 * 平台细节隔离在本文件：卡片 schema 翻译、cardAction → 行动项落库 → updateCard。
 * 单测经 channelFactory 注入 fake channel；真实 SDK 只在 e2e 手测。
 */
import * as lark from '@larksuiteoapi/node-sdk'
import type { BoardDb } from './db'
import {
  handleApprovalCallback,
  type ApprovalCard,
  type ImPlatformConfig,
} from './im'
import type { ImPushChannel } from './notify'

export interface FeishuChannelLike {
  send(to: string, input: { text?: string; card?: object }): Promise<{ messageId: string }>
  updateCard(messageId: string, card: object): Promise<void>
  on(name: 'cardAction', handler: (evt: CardActionLike) => void | Promise<void>): () => void
  disconnect(): Promise<void>
}

export interface CardActionLike {
  messageId: string
  operator: { openId: string; userId?: string; name?: string }
  action: { value: unknown; tag: string }
}

/** 平台无关卡片模型 → 飞书交互卡片 schema（正文 = 依据 + 证据摘要 + 预期效果；按钮 value 编码 itemId+decision） */
export function feishuApprovalCard(card: ApprovalCard): object {
  const confidenceText = card.confidence !== null ? `${Math.round(card.confidence * 100)}%` : '人工'
  const metaLine = [`置信度 ${confidenceText}`, ...(card.evidenceLevel ? [`证据等级 ${card.evidenceLevel}`] : [])].join(' · ')
  const elements: Array<Record<string, unknown>> = [
    { tag: 'div', text: { tag: 'lark_md', content: `**依据**：${card.rationale}` } },
    { tag: 'div', text: { tag: 'lark_md', content: metaLine } },
  ]
  if (card.topFactQuote) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**证据摘要**\n> ${card.topFactQuote}` } })
  }
  if (card.expectedImpact) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**预期效果**：${card.expectedImpact}` } })
  }
  elements.push(
    { tag: 'hr' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '决策看板 · 点击按钮即完成审批' }] },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '采纳' },
          type: 'primary',
          value: { itemId: card.itemId, decision: 'accept' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '驳回' },
          type: 'danger',
          value: { itemId: card.itemId, decision: 'reject' },
        },
      ],
    },
  )
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: card.title.slice(0, 40) },
    },
    elements,
  }
}

/** 结果态卡片（回调后替换原卡片；无按钮） */
export function feishuResultCard(reply: string): object {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'grey', title: { tag: 'plain_text', content: '已处理 · 决策看板' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${reply}**` } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '留痕已同步 PC 看板' }] },
    ],
  }
}

export interface FeishuBridgeDeps {
  config: ImPlatformConfig
  /** M5：行动项事实源（board.db）；卡片回调直写行动项状态（与服务器共用同一连接） */
  db: BoardDb
  /** 测试注入；默认真实 LarkChannel（长连接） */
  channelFactory?: () => Promise<FeishuChannelLike>
}

export interface FeishuBridge extends ImPushChannel {
  stop(): Promise<void>
}

/** 建桥：连接长连接 + 挂 cardAction；sendApproval = 审批人单聊发文本摘要 + 高优卡片 */
export async function startFeishuBridge(deps: FeishuBridgeDeps): Promise<FeishuBridge> {
  const channel: FeishuChannelLike = await (deps.channelFactory
    ? deps.channelFactory()
    : adaptLarkChannel(deps.config))

  channel.on('cardAction', (evt) => {
    // 落库是事实源；卡片更新 best-effort（GRILL 决议 3/4）。身份校验先行（REVIEW cycle 1 MINOR-1）
    let reply: string
    try {
      if (!deps.config.approverUserId.startsWith('ou_')) {
        reply = '审批人配置尚未解析为 open_id，请重跑 scripts/feishu-demo.ts 自动解析后使用'
      } else if (evt.operator.openId !== deps.config.approverUserId) {
        reply = `非审批人操作，已拒绝（${evt.operator.name ?? evt.operator.openId}）`
      } else {
        const outcome = handleApprovalCallback(
          { ...asRecord(evt.action.value), operatorName: evt.operator.name ?? deps.config.approverName },
          { db: deps.db },
        )
        reply = outcome.reply
        console.log(`[im:feishu] 审批回调 ${outcome.applied ? '落库' : '未落库'}：${reply}`)
      }
    } catch (error) {
      // 写库等异常不冒泡进 SDK 事件层（REVIEW cycle 1 MINOR-3）
      reply = '审批落库失败，请重试或到看板操作'
      console.error('[im:feishu] 审批回调处理异常：', (error as Error).message)
    }
    void channel.updateCard(evt.messageId, feishuResultCard(reply)).catch((error: unknown) => {
      console.warn('[im:feishu] 卡片结果态更新失败（审批已落库，不回滚）：', (error as Error).message)
    })
  })

  return {
    async sendApproval(digest: string, cards: ApprovalCard[]): Promise<void> {
      await channel.send(deps.config.approverUserId, { text: digest })
      for (const card of cards) {
        await channel.send(deps.config.approverUserId, { card: feishuApprovalCard(card) })
      }
    },
    async stop(): Promise<void> {
      await channel.disconnect()
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** 真实 SDK LarkChannel → FeishuChannelLike（仅此处触碰 SDK 网络） */
async function adaptLarkChannel(config: ImPlatformConfig): Promise<FeishuChannelLike> {
  const channel = lark.createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: lark.LoggerLevel.warn,
  })
  await channel.connect()
  return {
    send: (to, input) => channel.send(to, input as Parameters<typeof channel.send>[1]),
    updateCard: (messageId, card) => channel.updateCard(messageId, card),
    on: (name, handler) => channel.on(name, handler),
    disconnect: () => channel.disconnect(),
  }
}
