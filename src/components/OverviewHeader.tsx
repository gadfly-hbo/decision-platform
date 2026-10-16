import { useEffect, useRef, useState } from 'react'
import type { BoardView, ReportRecord } from '../data'
import { REPORT_STATUS_LABELS, formatDateTime, REPORT_ACCEPT } from '../data'
import type { UploadOutcome } from '../useBoardStore'

export const REGENERATE_HINT =
  '重新生成将删除该报告中仍处「建议」状态的行动项；已采纳/已驳回/含任务的行动项保留'
export const EXTRACTING_MESSAGE = '正在抽取行动项，模型调用最长约 2 分钟，完成后自动刷新。'
export const MODEL_UNAVAILABLE_MESSAGE = '模型服务不可用：未配置 API 密钥，无法抽取行动项。配置密钥后点击重试。'
export const DEFAULT_PROJECT_LEDE = '报告驱动的行动闭环'

interface OverviewHeaderProps {
  view: BoardView
  drawerOpen: boolean
  drawerBtnRef: React.RefObject<HTMLButtonElement | null>
  onToggleDrawer(): void
  onUpload(files: File[]): Promise<UploadOutcome[]>
  onExtract(report: ReportRecord, force?: boolean): void
  modelAvailable?: boolean
  /** S15 入口（M7）：「汇报模式」主级按钮；ref 供模式关闭后焦点返回（M7-US9） */
  presentationBtnRef?: React.RefObject<HTMLButtonElement | null>
  onOpenPresentation(): void
}

/** S1 项目概览头（v5：项目名+purpose+项目内统计+通知 chip）+ S1b 报告区（上传报告 + 项目内报告列表） */
export function OverviewHeader({
  view,
  drawerOpen,
  drawerBtnRef,
  onToggleDrawer,
  onUpload,
  onExtract,
  modelAvailable = true,
  presentationBtnRef,
  onOpenPresentation,
}: OverviewHeaderProps) {
  const { suggested, adopted, dismissed, manual } = view.stats
  return (
    <>
      <header className="overview">
        <div className="overview-row">
          <div className="overview-heading">
            <h1 className="page-title">{view.project.title}</h1>
            <p className="overview-lede">{view.project.purpose || DEFAULT_PROJECT_LEDE}</p>
          </div>
          <div className="overview-actions">
            <button
              ref={presentationBtnRef}
              type="button"
              className="primary-btn presentation-entry"
              onClick={onOpenPresentation}
            >
              汇报模式
            </button>
            <button
              ref={drawerBtnRef}
              type="button"
              className="drawer-toggle"
              aria-expanded={drawerOpen}
              aria-controls="run-drawer"
              onClick={onToggleDrawer}
            >
              运行详情
            </button>
          </div>
        </div>
        <p className="overview-meta">
          共 {view.reports.length} 份报告 · 建议 {suggested} · 已采纳 {adopted} · 已驳回 {dismissed} · 人工 {manual}
          <NotifyChip notify={view.notify} projectTitle={view.project.title} />
        </p>
        {!view.modelChain.available && <p className="board-error">{MODEL_UNAVAILABLE_MESSAGE}</p>}
      </header>
      <ReportZone view={view} onUpload={onUpload} onExtract={onExtract} modelAvailable={modelAvailable} />
    </>
  )
}

/** S1 通知 chip 四态（v5：`已推送 · {项目名}/{报告名}` 短形态，G5'） */
function NotifyChip({ notify, projectTitle }: { notify: BoardView['notify']; projectTitle: string }) {
  if (!notify.configured) return <span className="chip notify-chip warn">推送未配置</span>
  if (notify.imConfigured) {
    return notify.lastPushedReport ? (
      <span className="chip notify-chip">
        已推送 · {projectTitle}/{notify.lastPushedReport}
      </span>
    ) : (
      <span className="chip notify-chip warn">已配置 · 未推送</span>
    )
  }
  return <span className="chip notify-chip warn">未配置飞书 · 文本摘要推送</span>
}

interface ReportZoneProps {
  view: BoardView
  onUpload(files: File[]): Promise<UploadOutcome[]>
  onExtract(report: ReportRecord, force?: boolean): void
  modelAvailable?: boolean
}

/** S1b 报告区（v5）：「上传报告」主按钮（隐藏 input，多文件多格式）+ 项目内报告列表四态 */
function ReportZone({ view, onUpload, onExtract, modelAvailable }: ReportZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [failures, setFailures] = useState<UploadOutcome[]>([])
  const extracting = view.reports.some((report) => report.status === 'extracting')

  const pick = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const files = Array.from(fileList)
    setUploading(true)
    const outcomes = await onUpload(files)
    setUploading(false)
    setFailures(outcomes.filter((it) => !it.ok)) // 失败项独立列表项呈现（G2' 单败不连锁）
    if (inputRef.current) inputRef.current.value = '' // 同名文件可重选
  }

  return (
    <section className="report-strip" aria-label="报告">
      <div className="report-strip-head">
        <h3 className="run-section-title">报告</h3>
        <input
          ref={inputRef}
          type="file"
          accept={REPORT_ACCEPT}
          multiple
          className="upload-input"
          onChange={(event) => void pick(event.target.files)}
        />
        <button type="button" className="primary-btn upload-btn" disabled={uploading} onClick={() => inputRef.current?.click()}>
          上传报告
        </button>
      </div>
      {uploading && (
        <p className="upload-progress" aria-live="polite">
          上传中
        </p>
      )}
      {extracting && (
        <p className="extract-live" aria-live="polite">
          {EXTRACTING_MESSAGE}
        </p>
      )}
      {failures.map((failure) => (
        <p key={failure.filename} className="report-error">
          上传失败：{failure.error}
        </p>
      ))}
      <ul className="report-strip-list">
        {view.reports.map((report) => (
          <ReportStripItem key={report.id} report={report} onExtract={onExtract} modelAvailable={modelAvailable} />
        ))}
      </ul>
    </section>
  )
}

function ReportStripItem({
  report,
  onExtract,
  modelAvailable,
}: {
  report: ReportRecord
  onExtract(report: ReportRecord, force?: boolean): void
  modelAvailable?: boolean
}) {
  // 重新生成两段式（G3 沿用）：首点变「确认重新生成」+ 删除范围提示，失焦或 3 秒未点自动还原
  const [armed, setArmed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const arm = () => {
    setArmed(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setArmed(false), 3000)
  }

  const confirmForce = () => {
    setArmed(false)
    clearTimeout(timerRef.current)
    onExtract(report, true)
  }

  return (
    <li className="report-strip-item">
      <span className="report-name">{report.filename}</span>
      <span className="report-time">{formatDateTime(report.importedAt)}</span>
      <span className={`chip report-status rs-${report.status}`}>
        {report.status === 'extracting' && <i className="spinner" aria-hidden="true" />}
        {REPORT_STATUS_LABELS[report.status]}
      </span>
      {report.status === 'pending' && (
        <button type="button" className="extract-btn" disabled={!modelAvailable} onClick={() => onExtract(report)}>
          抽取
        </button>
      )}
      {report.status === 'failed' && (
        <>
          <span className="report-error">{report.error ?? '未知原因'}</span>
          <button type="button" className="extract-btn" disabled={!modelAvailable} onClick={() => onExtract(report)}>
            重试
          </button>
        </>
      )}
      {report.status === 'done' &&
        (armed ? (
          <span className="force-confirm">
            <span className="force-hint">{REGENERATE_HINT}</span>
            <button type="button" className="extract-btn" onClick={confirmForce}>
              确认重新生成
            </button>
          </span>
        ) : (
          <button type="button" className="extract-btn" onClick={arm} onBlur={() => setArmed(false)}>
            重新生成
          </button>
        ))}
    </li>
  )
}
