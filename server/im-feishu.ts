/**
 * M4b 飞书适配器：LarkChannel 长连接（零公网入站，前置门实测通过 2026-09-27）。
 * 平台细节隔离在本文件：卡片 schema 翻译、cardAction → 纯函数落库 → updateCard。
 * 单测经 channelFactory 注入 fake channel；真实 SDK 只在 e2e 手测。
 */
import * as lark from '@larksuiteoapi/node-sdk'
import { readActionStore, writeActionStore } from './actions'
import {
  handleApprovalCallback,
  type ApprovalCard,
  type ImPlatformConfig,
} from './im'
import type { ImPushChannel } from './notify'
import { latestPeriodInDir } from './notify'

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

const SEVERITY_TEMPLATE: Record<string, string> = { high: 'red', medium: 'orange', low: 'turquoise' }

/** 平台无关卡片模型 → 飞书交互卡片 schema（按钮 value 编码 actionId+decision） */
export function feishuApprovalCard(card: ApprovalCard): object {
  const attributionLines =
    card.attribution.length > 0
      ? card.attribution
          .map((a) => `· ${a.dimension}　${a.contribution > 0 ? '+' : ''}${a.contribution}${a.delta ? `（${a.delta}）` : ''}`)
          .join('\n')
      : '· 无归因明细'
  const actionButtons = card.actions.flatMap((a) => [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: `采纳：${a.text}`.slice(0, 20) },
      type: 'primary',
      value: { conclusionId: card.conclusionId, actionId: a.actionId, decision: 'accept', period: card.period },
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '驳回' },
      type: 'danger',
      value: { conclusionId: card.conclusionId, actionId: a.actionId, decision: 'reject', period: card.period },
    },
  ])
  return {
    config: { wide_screen_mode: true },
    header: {
      template: SEVERITY_TEMPLATE[card.severity] ?? 'grey',
      title: { tag: 'plain_text', content: `【${card.severity === 'high' ? '高' : card.severity === 'medium' ? '中' : '低'}】${card.title}` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**决策依据**：${card.summary}\n**窗口** ${card.window} · 期次 ${card.period}`,
        },
      },
      { tag: 'div', text: { tag: 'lark_md', content: `**归因 top 渠道**\n${attributionLines}` } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '决策看板 · 点击按钮即完成审批' }] },
      { tag: 'action', actions: actionButtons },
    ],
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
  actionsFile: string
  dataDir: string
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
        // currentPeriod=目录最新期次（时效校验，proposal §8）
        const currentPeriod = latestPeriodInDir(deps.dataDir) ?? ''
        const store = readActionStore(deps.actionsFile)
        const outcome = handleApprovalCallback(
          { ...asRecord(evt.action.value), operatorName: evt.operator.name ?? deps.config.approverName },
          { store, period: currentPeriod, currentPeriod, now: new Date().toISOString() },
        )
        if (outcome.applied) {
          writeActionStore(deps.actionsFile, outcome.store)
        }
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
