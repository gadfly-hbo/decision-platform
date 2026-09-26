import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DashboardData } from '../src/data/types'
import { demoData } from '../src/data/demo'
import { parseMemberWeeklyCsv, extractPeriod, ReportParseError } from './report/parseCsv'
import { buildConclusions } from './rules/engine'
import { MEMBER_METRIC_DEFS } from './rules/metricDefs'

const LEDE = '打开就知道今天要拍板什么：按紧急度排序的结论，展开可查推导过程与核心指标，直接采纳建议行动。'

/** 目录内按文件名日期取最新 CSV（无日期的文件排最后；同日期多份时取 readdirSync 列出顺序的首个——文档化行为） */
function latestCsvPath(dataDir: string): { path: string; date: string } | null {
  const entries = readdirSync(dataDir)
    .filter((name) => name.endsWith('.csv'))
    .map((name) => {
      const date = extractPeriod(name)
      return { name, date, path: join(dataDir, name) }
    })
    .sort((a, b) => b.date.localeCompare(a.date))
  return entries[0] ? { path: entries[0].path, date: entries[0].date } : null
}

/**
 * 由 dataDir 的最新周报构建看板数据；目录为空或解析失败时回退演示数据（isDemo=true）。
 * 解析失败按"接入即校验"显式记录到控制台，不静默。
 */
export function buildDashboardData(dataDir: string): DashboardData {
  try {
    const latest = latestCsvPath(dataDir)
    if (!latest) throw new ReportParseError(`目录无 CSV：${dataDir}`)
    const csvText = readFileSync(latest.path, 'utf-8')
    const report = parseMemberWeeklyCsv(csvText, latest.path)
    if (!report.period) {
      throw new ReportParseError(`文件名无日期，无法确定期次：${latest.path}`)
    }
    const conclusions = buildConclusions(report)
    return {
      title: '决策看板',
      lede: LEDE,
      window: `${report.period}（本期 vs 去年同期）`,
      updatedAt: `${report.period} 周报`,
      metrics: [...MEMBER_METRIC_DEFS],
      series: [],
      conclusions,
      isDemo: false,
      period: report.period,
    }
  } catch (error) {
    console.warn('[dashboard] 回退演示数据：', (error as Error).message)
    return { ...demoData, isDemo: true }
  }
}
