/**
 * M4 切片6 · 飞书全链路 e2e（真实 SDK，隔离数据，不碰生产 data/）
 *   新期次样本 → 60s 调度扫描（首扫 2s）→ 审批人手机收到 文本摘要+高优卡片
 *   → 手机点【采纳】→ 回调落库（decidedBy/decidedVia=card）→ 卡片变结果态
 *   → 本脚本轮询 actions store 验证留痕并打印 /api/dashboard 结论状态
 * 运行：npx tsx scripts/e2e-feishu.ts（手机飞书待命）
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../server/index'
import { startFeishuBridge } from '../server/im-feishu'
import { readImConfig } from '../server/im'
import { readActionStore } from '../server/actions'

const E2E_PORT = 9650
const E2E_PERIOD = '2026-10-03'

async function main(): Promise<void> {
  const imConf = readImConfig(join(process.cwd(), 'data', 'im.json'))
  const feishu = imConf?.platforms.find((p) => p.platform === 'feishu')
  if (!feishu) throw new Error('data/im.json 缺 feishu 配置')

  const tmp = mkdtempSync(join(tmpdir(), 'dp-e2e-feishu-'))
  const actionsFile = join(tmp, 'actions.json')
  const notifyStateFile = join(tmp, 'notify-state.json')
  cpSync(join(process.cwd(), 'server/report/testdata', 'sample.csv'), join(tmp, `会员周报-${E2E_PERIOD}.csv`))
  console.log(`[e2e] 隔离数据就绪：期次 ${E2E_PERIOD}（生产 data/ 不受影响）`)

  const bridge = await startFeishuBridge({ config: feishu, actionsFile, dataDir: tmp })
  const server = startServer(E2E_PORT, '127.0.0.1', {
    dataDir: tmp,
    actionsFile,
    notifyStateFile,
    notifyFile: join(tmp, 'notify.json'), // 无群机器人配置 → IM 通道独占
    imChannel: bridge,
  })
  console.log(`[e2e] 服务与桥接已启动 http://127.0.0.1:${E2E_PORT}（首扫 2s 后自动推送）`)

  const deadline = Date.now() + 240_000
  try {
    // 阶段1：等调度器推送完成（state 落盘）
    while (Date.now() < deadline) {
      await sleep(1_000)
      if (existsSync(notifyStateFile) && JSON.parse(readFileSync(notifyStateFile, 'utf-8')).lastPushedPeriod === E2E_PERIOD) break
    }
    if (!existsSync(notifyStateFile) || JSON.parse(readFileSync(notifyStateFile, 'utf-8')).lastPushedPeriod !== E2E_PERIOD) {
      throw new Error('240s 内推送未完成（检查手机是否收到摘要+卡片）')
    }
    console.log('[e2e] ① 新期次自动推送完成（未打开看板）——请在手机上点卡片【采纳】（可再点一次看「已处理」提示）')

    // 阶段2：等审批回调落库
    let decided: string | null = null
    while (Date.now() < deadline) {
      await sleep(1_000)
      const store = readActionStore(actionsFile)
      const hit = Object.entries(store).find(([, r]) => r.decidedVia === 'card')
      if (hit) {
        decided = hit[0]
        break
      }
    }
    if (!decided) throw new Error('240s 内未收到审批回调')

    // 阶段3：验证留痕 + 看板状态
    const record = readActionStore(actionsFile)[decided]
    console.log('[e2e] ② 审批已落库留痕：', JSON.stringify(record, null, 2))
    const dash = (await (await fetch(`http://127.0.0.1:${E2E_PORT}/api/dashboard`)).json()) as {
      conclusions: Array<{ id: string; severity: string; actions: Array<{ id: string }> }>
      period: string
    }
    const owner = dash.conclusions.find((c) => c.actions.some((a) => a.id === decided))
    console.log(
      `[e2e] ③ 看板同步：期次 ${dash.period}，行动 ${decided}（结论 ${owner?.id ?? '?'} / ${owner?.severity ?? '?'}）状态 ${record.status}，审批人 ${record.decidedBy}`,
    )
    console.log('[e2e] ✔ 全链路通过：导入→自动推卡→手机审批→落库留痕→看板可查')
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
