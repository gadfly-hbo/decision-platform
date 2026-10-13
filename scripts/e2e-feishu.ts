/**
 * 飞书全链路 e2e（真实 SDK + 真实模型抽取一次，隔离数据，不碰生产 data/）——M6 项目化版。
 * 链路：建项目 → 上传 md 报告（真实抽取一次）→ 轮询 board 到 done → 断言行动项与推送
 *   （摘要【项目名】+ 高优卡片）→ 手机点【采纳】→ 回调落库留痕 → 看板同步 → 清理。
 * 运行：npx tsx scripts/e2e-feishu.ts（手机飞书待命；本机需有模型密钥）
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../server/index'
import { startFeishuBridge } from '../server/im-feishu'
import { openBoardDb } from '../server/db'
import { readImConfig } from '../server/im'
import { composeDefaultAgent } from '../server/agent/compose'

const E2E_PORT = 9650
const BASE = `http://127.0.0.1:${E2E_PORT}`
const DEADLINE_MS = 240_000

const SAMPLE_REPORT = `# 会员运营周报（e2e 样本）

会员复购率由 12% 降至 9%，复购会员贡献销售额占比 48%，沉睡会员规模连续四周扩大。
建议对 90 天未复购会员发放阶梯券召回，预期 30 日内复购率回升约 2pp。
`

interface BoardShape {
  reports: Array<{ slug: string; status: string }>
  actionItems: Array<{ id: string; title: string; status: string; decidedVia: string | null }>
}

async function get(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`)
}

async function pollBoard(projectId: string): Promise<BoardShape> {
  const deadline = Date.now() + DEADLINE_MS
  for (;;) {
    const board = (await (await get(`/api/projects/${projectId}/board`)).json()) as BoardShape
    const report = board.reports[0]
    if (report && report.status === 'done') return board
    if (report && report.status === 'failed') throw new Error(`抽取失败：${JSON.stringify(board.reports[0])}`)
    if (Date.now() > deadline) throw new Error('240s 内抽取未完成')
    await sleep(2_000)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  const imConf = readImConfig(join(process.cwd(), 'data', 'im.json'))
  const feishu = imConf?.platforms.find((p) => p.platform === 'feishu')
  if (!feishu) throw new Error('data/im.json 缺 feishu 配置')

  const tmp = mkdtempSync(join(tmpdir(), 'dp-e2e-feishu-'))
  const db = openBoardDb(join(tmp, 'board.db'))
  const bridge = await startFeishuBridge({ config: feishu, db })
  const composed = composeDefaultAgent(join(tmp, 'agent')) // 真实模型链（账本/审计落在 tmp）
  const server = startServer(E2E_PORT, '127.0.0.1', {
    db,
    projectsDir: join(tmp, 'projects'),
    notifyStateFile: join(tmp, 'notify-state.json'),
    notifyFile: join(tmp, 'notify.json'), // 无群机器人配置 → IM 通道独占
    imChannel: bridge,
    agentRunner: composed.runner,
  })
  console.log(`[e2e] 服务与桥接已启动 ${BASE}（真实模型抽取一次）`)

  try {
    // ① 建项目
    const created = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'e2e 会员运营', purpose: '隔离数据' }),
    })
    if (!created.ok) throw new Error(`项目创建失败：${await created.text()}`)
    const project = (await created.json()) as { id: string; title: string }
    console.log(`[e2e] ① 项目就绪：${project.id}`)

    // ② 上传报告（异步触发真实抽取）
    const uploaded = await fetch(`${BASE}/api/projects/${project.id}/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ filename: '会员运营周报.md', contentBase64: Buffer.from(SAMPLE_REPORT).toString('base64') }] }),
    })
    if (!uploaded.ok) throw new Error(`上传失败：${await uploaded.text()}`)
    console.log('[e2e] ② 上传完成（抽取进行中，最长约 2 分钟）')

    // ③ 轮询 board 到 done → 断言行动项
    const board = await pollBoard(project.id)
    console.log(`[e2e] ③ 抽取完成：行动项 ${board.actionItems.length} 条（${board.actionItems.map((i) => i.title).join(' / ')}）`)
    if (board.actionItems.length === 0) throw new Error('抽取 0 条行动项（样本报告预期 ≥1）')

    // ④ 推送断言：notify-state 落 projectId:slug（事件驱动，手机应收到【e2e 会员运营】摘要 + 高优卡片）
    const deadline = Date.now() + DEADLINE_MS
    let pushed = false
    while (Date.now() < deadline) {
      await sleep(1_000)
      const state = JSON.parse(readFileSync(join(tmp, 'notify-state.json'), 'utf-8')) as { pushedSlugs?: string[] }
      if (state.pushedSlugs?.some((key) => key.startsWith(`${project.id}:`))) {
        pushed = true
        break
      }
    }
    if (!pushed) throw new Error('240s 内推送未完成（检查手机是否收到【e2e 会员运营】摘要+卡片）')
    console.log('[e2e] ④ 报告推送完成——请在手机上点卡片【采纳】（可再点一次看「已按首次点击结果处理」提示）')

    // ⑤ 等审批回调落库
    let decided: string | null = null
    while (Date.now() < deadline) {
      await sleep(1_000)
      const latest = await pollBoard(project.id)
      const hit = latest.actionItems.find((item) => item.decidedVia === 'card')
      if (hit) {
        decided = hit.id
        break
      }
    }
    if (!decided) throw new Error('240s 内未收到审批回调')

    // ⑥ 验证留痕 + 看板同步 + 清理项目
    const finalBoard = await pollBoard(project.id)
    const record = finalBoard.actionItems.find((item) => item.id === decided)
    console.log('[e2e] ⑤ 审批已落库留痕：', JSON.stringify(record))
    const del = await fetch(`${BASE}/api/projects/${project.id}`, { method: 'DELETE' })
    console.log(`[e2e] ⑥ 隔离项目清理：${del.status}`)
    console.log('[e2e] ✔ 全链路通过：项目→上传→抽取→推送→手机审批→落库→清理')
    await sleep(10_000) // 留时间给「重复点击」观察
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await bridge.stop()
    rmSync(tmp, { recursive: true, force: true })
    console.log('[e2e] 已清理退出')
  }
}

void main().catch((error: unknown) => {
  console.error('[e2e] ✘', (error as Error).message)
  process.exit(1)
})
