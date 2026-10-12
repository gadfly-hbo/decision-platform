/**
 * 飞书全链路 e2e（真实 SDK，隔离数据，不碰生产 data/）——M5 行动闭环版
 *   样本 .md 报告 → 手动触发抽取（真实模型链）→ 抽取完成后调度推送
 *   → 审批人手机收到 文本摘要+审批卡片 → 手机点【采纳】→ 回调落库（decidedBy/decidedVia=card）
 *   → 本脚本轮询 board.db 验证留痕并打印 /api/dashboard 行动项状态
 * 运行：npx tsx scripts/e2e-feishu.ts（手机飞书待命）
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../server/index'
import { startFeishuBridge } from '../server/im-feishu'
import { createReportPipeline } from '../server/reports'
import { listActionItems } from '../server/db'
import { composeDefaultAgent } from '../server/agent/compose'
import { readImConfig } from '../server/im'

const E2E_PORT = 9650
const REPORT_SLUG = '会员周报-2026-10-10'

const SAMPLE_REPORT = `# 会员周报（e2e 样本）

会员复购率由 12% 降至 9%，复购会员贡献销售额占比 48%。建议对 90 天未复购会员发放阶梯券召回。
`

async function main(): Promise<void> {
  const imConf = readImConfig(join(process.cwd(), 'data', 'im.json'))
  const feishu = imConf?.platforms.find((p) => p.platform === 'feishu')
  if (!feishu) throw new Error('data/im.json 缺 feishu 配置')

  const tmp = mkdtempSync(join(tmpdir(), 'dp-e2e-feishu-'))
  const dbPath = join(tmp, 'board.db')
  const notifyStateFile = join(tmp, 'notify-state.json')
  writeFileSync(join(tmp, `${REPORT_SLUG}.md`), SAMPLE_REPORT, 'utf-8')
  console.log(`[e2e] 隔离数据就绪：报告 ${REPORT_SLUG}.md（生产 data/ 不受影响）`)

  // 服务器与桥接共用同一 db 连接（卡片回调直写行动项状态）
  const pipeline = createReportPipeline(tmp, dbPath)
  const bridge = await startFeishuBridge({ config: feishu, db: pipeline.db })
  const agentRunner = composeDefaultAgent(tmp).runner
  const server = startServer(E2E_PORT, '127.0.0.1', {
    dataDir: tmp,
    pipeline,
    notifyStateFile,
    notifyFile: join(tmp, 'notify.json'), // 无群机器人配置 → IM 通道独占
    imChannel: bridge,
    agentRunner,
  })
  console.log(`[e2e] 服务与桥接已启动 http://127.0.0.1:${E2E_PORT}`)

  const deadline = Date.now() + 240_000
  try {
    // 阶段1：手动触发抽取加速（真实模型链）；调度漏斗每个 tick 扫描 → 未推送 done 报告自动推一轮
    const extract = await fetch(`http://127.0.0.1:${E2E_PORT}/api/reports/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: REPORT_SLUG }),
    })
    if (!extract.ok) throw new Error(`抽取失败：${await extract.text()}`)
    console.log('[e2e] ① 抽取完成：', JSON.stringify((await extract.json()).results))

    const pushed = () => {
      try {
        return (JSON.parse(readFileSync(notifyStateFile, 'utf-8')) as { pushedSlugs?: string[] }).pushedSlugs?.includes(REPORT_SLUG)
      } catch {
        return false
      }
    }
    while (Date.now() < deadline) {
      await sleep(1_000)
      if (pushed()) break
    }
    if (!pushed()) {
      throw new Error('240s 内推送未完成（检查手机是否收到摘要+卡片）')
    }
    console.log('[e2e] ② 报告推送完成——请在手机上点卡片【采纳】（可再点一次看「已按首次点击结果处理」提示）')

    // 阶段2：等审批回调落库
    let decided: string | null = null
    while (Date.now() < deadline) {
      await sleep(1_000)
      const hit = listActionItems(pipeline.db).find((item) => item.decidedVia === 'card')
      if (hit) {
        decided = hit.id
        break
      }
    }
    if (!decided) throw new Error('240s 内未收到审批回调')

    // 阶段3：验证留痕 + 看板状态
    const record = listActionItems(pipeline.db).find((item) => item.id === decided)
    console.log('[e2e] ③ 审批已落库留痕：', JSON.stringify(record, null, 2))
    const dash = (await (await fetch(`http://127.0.0.1:${E2E_PORT}/api/dashboard`)).json()) as {
      stats: Record<string, number>
      actionItems: Array<{ id: string; status: string }>
    }
    const item = dash.actionItems.find((it) => it.id === decided)
    console.log(`[e2e] ④ 看板同步：行动 ${decided} 状态 ${item?.status ?? '?'}，统计 ${JSON.stringify(dash.stats)}`)
    console.log('[e2e] ✔ 全链路通过：报告抽取→自动推卡→手机审批→落库留痕→看板可查')
    await sleep(15_000) // 留时间给「重复点击」观察
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await bridge.stop()
    rmSync(tmp, { recursive: true, force: true })
    console.log('[e2e] 已清理退出')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

void main().catch((error: unknown) => {
  console.error('[e2e] ✘', (error as Error).message)
  process.exit(1)
})
