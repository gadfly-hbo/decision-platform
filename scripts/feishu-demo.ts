/**
 * M4 切片5 · 飞书前置门 demo（红队 KA2）：内网三步实测
 *   1) 发交互卡片（【采纳】【驳回】按钮）到审批人飞书单聊
 *   2) 手机在卡片上点按钮 → 本机长连接收到回调并打印
 *   3) 回调内把卡片更新为结果态
 * 全程仅出站连接（WSS/HTTPS），零公网入站——验证「内网 Mac mini」部署假设。
 * 运行：npx tsx scripts/feishu-demo.ts（先在 data/im.json 填好 feishu 平台凭证）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as lark from '@larksuiteoapi/node-sdk'
import { readImConfig, type ImPlatformConfig } from '../server/im'

const imFile = join(process.cwd(), 'data', 'im.json')
const DEMO_ACTION_ID = 'a-divergence-1'

const demoCard = (approverName: string): object => ({
  config: { wide_screen_mode: true },
  header: {
    template: 'red',
    title: { tag: 'plain_text', content: '【高】会员零售额同比 +8.8%，与大盘零售额 -5.9% 背离' },
  },
  elements: [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          `**决策依据**：会员零售额逆势增长，与大盘方向相反，需确认增长质量（新客/复购结构）。\n**窗口** 09-12 ~ 09-25 · 期次 2026-09-26 · 审批人 ${approverName}`,
      },
    },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          '**归因 top 渠道**\n· 加盟·A品牌-西南加盟　+42.1 万（+38%）\n· 直营·A品牌-华东直营　-18.6 万（-12%）\n· 加盟·A品牌-华南加盟　+9.3 万（+6%）',
      },
    },
    { tag: 'hr' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '决策看板 · 飞书前置门 demo（不是真实审批）' }] },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '采纳' },
          type: 'primary',
          value: { actionId: DEMO_ACTION_ID, decision: 'accept' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '驳回' },
          type: 'danger',
          value: { actionId: DEMO_ACTION_ID, decision: 'reject' },
        },
      ],
    },
  ],
})

const resultCard = (reply: string): object => ({
  config: { wide_screen_mode: true },
  header: {
    template: 'grey',
    title: { tag: 'plain_text', content: '已处理 · 决策看板 demo' },
  },
  elements: [
    { tag: 'div', text: { tag: 'lark_md', content: `**${reply}**` } },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '卡片回调 → 落库 → 卡片更新 链路打通' }] },
  ],
})

/** approverUserId 若是手机号/邮箱（首次配置），解析成 open_id 并回写 im.json */
async function resolveOpenId(feishu: ImPlatformConfig): Promise<string> {
  if (feishu.approverUserId.startsWith('ou_')) return feishu.approverUserId
  const client = new lark.Client({
    appId: feishu.appId,
    appSecret: feishu.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  })
  const data = feishu.approverUserId.includes('@')
    ? { emails: [feishu.approverUserId] }
    : { mobiles: [feishu.approverUserId.replace(/[-\s]/g, '')] }
  const res = await client.contact.user.batchGetId({ data, params: { user_id_type: 'open_id' } })
  const openId = res.data?.user_list?.find((u) => u.user_id)?.user_id
  if (!openId) throw new Error(`未能由「${feishu.approverUserId}」解析 open_id：成员不在企业内或应用缺 contact:user.id:readonly 权限`)
  const raw = JSON.parse(readFileSync(imFile, 'utf-8')) as { platforms: ImPlatformConfig[] }
  raw.platforms.find((p) => p.platform === 'feishu')!.approverUserId = openId
  writeFileSync(imFile, JSON.stringify(raw, null, 2), 'utf-8')
  console.log(`[demo] open_id 已解析并回写 im.json：${openId}`)
  return openId
}

async function main(): Promise<void> {
  const conf = readImConfig(imFile)
  const feishu = conf?.platforms.find((p) => p.platform === 'feishu')
  if (!feishu) {
    console.error('[demo] data/im.json 未配置或缺少 feishu 平台，请先填写凭证')
    process.exit(1)
  }
  const openId = await resolveOpenId(feishu)
  const channel = lark.createLarkChannel({ appId: feishu.appId, appSecret: feishu.appSecret, loggerLevel: lark.LoggerLevel.warn })
  await channel.connect()
  console.log('[demo] ① 长连接已建立（零公网入站）')

  const { messageId } = await channel.send(openId, { card: demoCard(feishu.approverName) })
  console.log(`[demo] ② 卡片已发送（messageId=${messageId}）——请在手机飞书上点【采纳】或【驳回】`)

  let got = false
  channel.on('cardAction', (evt) => {
    got = true
    const value = evt.action.value as { actionId: string; decision: 'accept' | 'reject' }
    console.log('[demo] ③ 收到按钮回调：', JSON.stringify({ operator: evt.operator, value }, null, 2))
    const reply = `已${value.decision === 'accept' ? '采纳' : '驳回'} · ${evt.operator.name ?? feishu.approverName} · ${new Date().toLocaleString('zh-CN')}`
    void channel
      .updateCard(evt.messageId, resultCard(reply))
      .then(() => {
        console.log(`[demo] ④ 卡片已更新为结果态：${reply}`)
        console.log('[demo] ✔ 前置门三步全部通过（发卡 / 收回调 / 更新卡片）')
        process.exit(0)
      })
      .catch((error: unknown) => {
        console.error('[demo] 卡片更新失败：', (error as Error).message)
        process.exit(1)
      })
  })

  setTimeout(() => {
    if (!got) {
      console.error('[demo] ✘ 180 秒内未收到按钮回调——请确认：应用已发布版本、可用范围含审批人、事件订阅选了长连接')
      process.exit(1)
    }
  }, 180_000).unref()
}

void main().catch((error: unknown) => {
  console.error('[demo] 失败：', (error as Error).message)
  process.exit(1)
})
