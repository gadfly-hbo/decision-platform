import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtractionRunner } from './agent/extract'
import type { ExtractionCalibration } from './agent/types'
import type { ReportRecord } from './db'
import { CARD_DISMISS_DEFAULT_REASON } from './board'
import {
  closeBoardDb,
  deleteStaleSuggested,
  getReportBySlug,
  insertExtractedActionItems,
  listActionItems,
  listReports,
  openBoardDb,
  updateReportStatus,
  upsertReport,
  type BoardDb,
} from './db'

/**
 * 报告管线（M5）：扫描 data/raw/ 的 .md/.txt → 注册（slug=文件名规范化）→ 抽取（幂等：每报告一次，
 * 失败可重试；force 按 G3 清理重建 suggested，保留已决/有任务项）。
 */

export function slugifyReportFilename(filename: string): string {
  return filename
    .replace(/\.(md|txt)$/i, '')
    .replace(/[\s/\\]+/g, '-')
    .trim()
}

function isReportFile(name: string): boolean {
  return /\.(md|txt)$/i.test(name)
}

/** 扫描目录：新文件注册为 pending；已注册 slug 原样保留（身份=文件名）。 */
export function scanReports(db: BoardDb, dataDir: string): ReportRecord[] {
  let entries: string[]
  try {
    entries = readdirSync(dataDir)
  } catch {
    return [] // 目录不存在：无报告（空态由调用方呈现）
  }
  for (const name of entries) {
    if (!isReportFile(name)) continue
    upsertReport(db, { slug: slugifyReportFilename(name), filename: name })
  }
  resetInterruptedExtracting(db)
  return listReports(db)
}

/** N4：进程重启遗留的 extracting（非本进程在抽）复位为 failed 可重试，避免永久卡死状态条。 */
function resetInterruptedExtracting(db: BoardDb): void {
  for (const report of listReports(db)) {
    if (report.status !== 'extracting' || inFlight.has(report.slug)) continue
    updateReportStatus(db, report.id, 'failed', '进程重启中断抽取，可重试')
  }
}

export interface ExtractResult {
  slug: string
  status: 'done' | 'failed' | 'skipped'
  inserted: number
  removedStale?: number
  error?: string
}

/** 同进程单飞：同一报告不并发抽取（调度器与手动端点竞争时）。 */
const inFlight = new Set<string>()

/**
 * G12 校准注入上下文：最近 ≤10 条驳回理由（有内容的；卡片渠道默认占位理由无信号，排除）
 * + 最近 ≤10 条人工补充（标题+依据）；两段皆空 → undefined（prompt 形态不变）。
 */
export function loadCalibrationContext(db: BoardDb): ExtractionCalibration | undefined {
  const items = listActionItems(db) // created_at DESC：取最近
  const dismissalReasons = items
    .filter(
      (item) =>
        item.status === 'dismissed' &&
        item.dismissedReason !== null &&
        item.dismissedReason.trim() !== '' &&
        item.dismissedReason !== CARD_DISMISS_DEFAULT_REASON,
    )
    .map((item) => item.dismissedReason as string)
    .slice(0, 10)
  const manualAdditions = items
    .filter((item) => item.sourceKind === 'manual' && item.status !== 'dismissed') // 已驳回的人工方向不再是关注点（理由段已体现）
    .map((item) => ({ title: item.title, rationale: item.rationale }))
    .slice(0, 10)
  if (dismissalReasons.length === 0 && manualAdditions.length === 0) return undefined
  return { dismissalReasons, manualAdditions }
}

export async function extractReports(
  db: BoardDb,
  dataDir: string,
  runner: ExtractionRunner,
  options: { slug?: string; force?: boolean } = {},
): Promise<ExtractResult[]> {
  scanReports(db, dataDir)
  const targets = options.slug
    ? [getReportBySlug(db, options.slug)].filter((r): r is ReportRecord => r !== null)
    : listReports(db).filter((r) => r.status === 'pending' || r.status === 'failed')
  const results: ExtractResult[] = []
  for (const report of targets) {
    if (inFlight.has(report.slug)) {
      results.push({ slug: report.slug, status: 'skipped', inserted: 0 })
      continue
    }
    if (report.status === 'done' && !options.force) {
      results.push({ slug: report.slug, status: 'skipped', inserted: 0 })
      continue
    }
    results.push(await extractOne(db, dataDir, runner, report, options.force ?? false))
  }
  return results
}

async function extractOne(
  db: BoardDb,
  dataDir: string,
  runner: ExtractionRunner,
  report: ReportRecord,
  force: boolean,
): Promise<ExtractResult> {
  inFlight.add(report.slug)
  updateReportStatus(db, report.id, 'extracting')
  try {
    const content = readFileSync(join(dataDir, report.filename), 'utf-8')
    const drafts = await runner.runExtraction({
      taskId: `extract:${report.slug}`,
      reportName: report.filename,
      reportContent: content,
      calibration: loadCalibrationContext(db), // G12：驳回理由 + 人工补充方向注入 prompt
    })
    const removedStale = force ? deleteStaleSuggested(db, report.id) : 0
    const ids = insertExtractedActionItems(db, report.id, drafts)
    updateReportStatus(db, report.id, 'done')
    return { slug: report.slug, status: 'done', inserted: ids.length, ...(removedStale ? { removedStale } : {}) }
  } catch (error) {
    const message = (error as Error).message
    updateReportStatus(db, report.id, 'failed', message)
    return { slug: report.slug, status: 'failed', inserted: 0, error: message }
  } finally {
    inFlight.delete(report.slug)
  }
}

export interface ReportPipeline {
  db: BoardDb
  listReports(): ReportRecord[]
  extract(runner: ExtractionRunner, options: { slug?: string; force?: boolean }): Promise<ExtractResult[]>
  close(): void
}

/** 组装一条管线（startServer 与测试共用）；runner 由调用方在抽取时传入。 */
export function createReportPipeline(dataDir: string, dbPath: string): ReportPipeline {
  const db = openBoardDb(dbPath)
  return {
    db,
    listReports: () => scanReports(db, dataDir),
    extract: (runner, options) => extractReports(db, dataDir, runner, options),
    close: () => closeBoardDb(db),
  }
}
