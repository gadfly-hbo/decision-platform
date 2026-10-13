import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtractionRunner } from './agent/extract'
import type { ExtractionCalibration } from './agent/types'
import { CARD_DISMISS_DEFAULT_REASON } from './board'
import {
  deleteStaleSuggested,
  getProject,
  getReportBySlug,
  insertExtractedActionItems,
  listActionItems,
  listReports,
  updateReportStatus,
  upsertReport,
  type BoardDb,
} from './db'

/**
 * 报告管线（M6 项目化）：扫描项目 reports 目录（data/projects/<id>/reports/）的 .md/.txt
 * → 注册（slug=项目内文件名规范化）→ 抽取（幂等：每报告一次，失败可重试；force 按 G3 清理重建
 * suggested，保留已决/有任务项）。共享单一 BoardDb，函数显式携带 (db, projectId, dir)。
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

/** 扫描项目 reports 目录：新文件注册为 pending；已注册 slug 原样保留（身份=项目内文件名）。 */
export function scanReports(db: BoardDb, projectId: string, reportsDir: string) {
  let entries: string[]
  try {
    entries = readdirSync(reportsDir)
  } catch {
    return listReports(db, projectId) // 目录不存在：项目暂无报告（上传/前端引导承接）
  }
  for (const name of entries) {
    if (!isReportFile(name)) continue
    upsertReport(db, projectId, { slug: slugifyReportFilename(name), filename: name })
  }
  resetInterruptedExtracting(db, projectId)
  return listReports(db, projectId)
}

/** N4：进程重启遗留的 extracting（非本进程在抽）复位为 failed 可重试，避免永久卡死状态条。 */
function resetInterruptedExtracting(db: BoardDb, projectId: string): void {
  for (const report of listReports(db, projectId)) {
    if (report.status !== 'extracting' || inFlight.has(inFlightKey(projectId, report.slug))) continue
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

const inFlight = new Set<string>()
const inFlightKey = (projectId: string, slug: string) => `${projectId}:${slug}`

/**
 * G12 校准注入上下文（M6 项目级）：本项目最近 ≤10 条驳回理由（有内容的；卡片默认占位无信号排除）
 * + 本项目 ≤10 条人工补充（标题+依据）；两段皆空 → undefined（prompt 形态不变）。
 */
export function loadCalibrationContext(db: BoardDb, projectId: string): ExtractionCalibration | undefined {
  const items = listActionItems(db, { projectId }) // created_at DESC：取最近
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
    .filter((item) => item.sourceKind === 'manual' && item.status !== 'dismissed') // 已驳回的人工方向不再是关注点
    .map((item) => ({ title: item.title, rationale: item.rationale }))
    .slice(0, 10)
  if (dismissalReasons.length === 0 && manualAdditions.length === 0) return undefined
  return { dismissalReasons, manualAdditions }
}

/** 同进程单飞：同一项目同一报告不并发抽取。 */
export interface ExtractOptions {
  slug?: string
  force?: boolean
  /** 抽取成功（done）后回调：事件驱动推送缝（M6-T2）；inserted=0 时由调用方决定是否推送 */
  onReportDone?: (info: { slug: string; inserted: number }) => void
}

export async function extractReports(
  db: BoardDb,
  projectId: string,
  reportsDir: string,
  runner: ExtractionRunner,
  options: ExtractOptions = {},
): Promise<ExtractResult[]> {
  const project = getProject(db, projectId)
  if (!project) throw new Error(`项目不存在：${projectId}`)
  scanReports(db, projectId, reportsDir)
  const targets = options.slug
    ? [getReportBySlug(db, projectId, options.slug)].filter((r): r is NonNullable<typeof r> => r !== null)
    : listReports(db, projectId).filter((r) => r.status === 'pending' || r.status === 'failed')
  const results: ExtractResult[] = []
  for (const report of targets) {
    if (inFlight.has(inFlightKey(projectId, report.slug))) {
      results.push({ slug: report.slug, status: 'skipped', inserted: 0 })
      continue
    }
    if (report.status === 'done' && !options.force) {
      results.push({ slug: report.slug, status: 'skipped', inserted: 0 })
      continue
    }
    results.push(await extractOne(db, projectId, reportsDir, runner, report, options))
  }
  return results
}

async function extractOne(
  db: BoardDb,
  projectId: string,
  reportsDir: string,
  runner: ExtractionRunner,
  report: { id: number; slug: string; filename: string },
  options: ExtractOptions,
): Promise<ExtractResult> {
  const force = options.force ?? false
  const key = inFlightKey(projectId, report.slug)
  inFlight.add(key)
  updateReportStatus(db, report.id, 'extracting')
  try {
    const content = readFileSync(join(reportsDir, report.filename), 'utf-8')
    const drafts = await runner.runExtraction({
      taskId: `extract:${projectId}:${report.slug}`,
      reportName: report.filename,
      reportContent: content,
      calibration: loadCalibrationContext(db, projectId), // G12：本项目驳回理由 + 人工补充方向注入 prompt
    })
    const removedStale = force ? deleteStaleSuggested(db, report.id) : 0
    const ids = insertExtractedActionItems(db, projectId, report.id, drafts)
    updateReportStatus(db, report.id, 'done')
    options.onReportDone?.({ slug: report.slug, inserted: ids.length }) // 事件驱动推送（M6-T2）
    return { slug: report.slug, status: 'done', inserted: ids.length, ...(removedStale ? { removedStale } : {}) }
  } catch (error) {
    const message = (error as Error).message
    updateReportStatus(db, report.id, 'failed', message)
    return { slug: report.slug, status: 'failed', inserted: 0, error: message }
  } finally {
    inFlight.delete(key)
  }
}
