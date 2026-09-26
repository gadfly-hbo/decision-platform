import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DashboardData, MetricSeries } from '../src/data/types'
import type { MetricKey, WeeklyReport } from './report/types'
import { demoData } from '../src/data/demo'
import { parseMemberWeeklyCsv, extractPeriod, ReportParseError } from './report/parseCsv'
import { buildConclusions } from './rules/engine'
import { MEMBER_METRIC_DEFS } from './rules/metricDefs'
import { readActionStore } from './actions'
import { buildActionReview } from './review'

const LEDE = '打开就知道今天要拍板什么：按紧急度排序的结论，展开可查推导过程与核心指标，直接采纳建议行动。'

/**
 * 解析目录内全部带日期的周报（期次升序）。
 * 最新一期损坏 → 上抛（外层按解析失败回退演示，不用旧数据冒充本期）；
 * 较旧文件损坏 → 记日志跳过（历史退化可接受）。
 */
function parseHistory(dataDir: string): WeeklyReport[] {
  const entries = readdirSync(dataDir)
    .filter((name) => name.endsWith('.csv'))
    .map((name) => ({ name, date: extractPeriod(name), path: join(dataDir, name) }))
    .filter((entry) => entry.date !== '')
    .sort((a, b) => a.date.localeCompare(b.date))
  if (entries.length === 0) {
    throw new ReportParseError(`目录无带日期的 CSV：${dataDir}`)
  }
  const history: WeeklyReport[] = []
  const seenPeriods = new Set<string>()
  entries.forEach((entry, index) => {
    try {
      const report = parseMemberWeeklyCsv(readFileSync(entry.path, 'utf-8'), entry.path)
      if (seenPeriods.has(report.period)) {
        console.warn('[dashboard] 同日期多份 CSV，取先列出者：', entry.name)
        return
      }
      seenPeriods.add(report.period)
      history.push(report)
    } catch (error) {
      if (index === entries.length - 1) throw error
      console.warn('[dashboard] 跳过损坏的历史文件：', entry.name, (error as Error).message)
    }
  })
  if (history.length === 0) {
    throw new ReportParseError(`目录内无有效周报：${dataDir}`)
  }
  return history
}

function sumCurrentOf(report: WeeklyReport, key: MetricKey): number {
  return report.rows.reduce((sum, row) => sum + row.metrics[key].current, 0)
}

/** 整体 6 指标的周度序列（每期一点，date=期次）；<2 期返回空（降级走贡献图） */
function buildOverallSeries(history: WeeklyReport[]): MetricSeries[] {
  if (history.length < 2) return []
  return MEMBER_METRIC_DEFS.map((def) => ({
    metricId: def.id,
    points: history.map((report) => ({ date: report.period, value: sumCurrentOf(report, def.id as MetricKey) })),
    baselines: [],
  }))
}

export interface DashboardOptions {
  /** 行动存储文件（默认 <项目根>/data/actions.json）；测试注入 tmp 文件 */
  actionsFile?: string
}

/**
 * 由 dataDir 的周报历史构建看板数据；目录为空或最新一期解析失败时回退演示数据（isDemo=true）。
 * 仅 ReportParseError 走演示回退（显式记日志）；引擎等代码缺陷上抛。
 */
export function buildDashboardData(dataDir: string, options: DashboardOptions = {}): DashboardData {
  let history: WeeklyReport[]
  try {
    history = parseHistory(dataDir)
  } catch (error) {
    if (!(error instanceof ReportParseError)) throw error
    console.warn('[dashboard] 回退演示数据：', (error as Error).message)
    return { ...demoData, isDemo: true }
  }

  const report = history[history.length - 1]
  const conclusions = buildConclusions(report)
  const actionsFile = options.actionsFile ?? join(process.cwd(), 'data', 'actions.json')
  const actionReview = buildActionReview(readActionStore(actionsFile), conclusions, report)
  return {
    title: '决策看板',
    lede: LEDE,
    window: `${report.period}（本期 vs 去年同期）`,
    updatedAt: `${report.period} 周报`,
    metrics: [...MEMBER_METRIC_DEFS],
    series: buildOverallSeries(history),
    conclusions,
    isDemo: false,
    period: report.period,
    actionReview,
    historyCount: history.length,
  }
}
