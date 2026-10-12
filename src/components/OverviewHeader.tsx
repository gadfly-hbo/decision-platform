import { useEffect, useRef, useState } from 'react'
import { REPORT_STATUS_LABELS, formatDateTime } from '../data'
import type { BoardView, ReportRecord } from '../data'

export const REEXTRACT_HINT =
  '重新抽取将删除该报告中仍处「建议」状态的行动项；已采纳/已驳回/含任务的行动项保留'
export const EXTRACTING_MESSAGE = '正在抽取行动项，模型调用最长约 2 分钟，完成后自动刷新。'
export const MODEL_UNAVAILABLE_MESSAGE = '模型服务不可用：未配置 API 密钥，无法抽取行动项。配置密钥后点击重试。'
export const DEMO_NOTE = '当前为演示数据：将分析报告（.md/.txt）放入 data/raw/ 后自动抽取真实行动项。'

interface OverviewHeaderProps {
  view: BoardView
  drawerOpen: boolean
  drawerBtnRef: React.RefObject<HTMLButtonElement | null>
  onToggleDrawer(): void
  onExtract(report: ReportRecord, force?: boolean): void
}

/** S1 概览头（统计/通知/演示/错误 chip + 运行详情开关）+ S1b 报告状态条 */
export function OverviewHeader({ view, drawerOpen, drawerBtnRef, onToggleDrawer, onExtract }: OverviewHeaderProps) {
  const latest = view.reports[0]
  const { suggested, adopted, dismissed, manual } = view.stats
  return (
    <>
      <header className="overview">
        <div className="overview-row">
          <div className="overview-heading">
            <h1 className="page-title">{view.title}</h1>
            <p className="overview-lede">{view.lede}</p>
          </div>
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
        <p className="overview-meta">
          {latest && <>最新报告 {latest.filename} · {formatDateTime(latest.importedAt)} 导入 · </>}
          共 {view.reports.length} 份报告 · 建议 {suggested} · 已采纳 {adopted} · 已驳回 {dismissed} · 人工 {manual}
          {view.isDemo && <span className="chip demo-chip">演示数据</span>}
          <NotifyChip notify={view.notify} />
        </p>
        {!view.modelChain.available && <p className="board-error">{MODEL_UNAVAILABLE_MESSAGE}</p>}
        {view.isDemo && <p className="demo-note">{DEMO_NOTE}</p>}
      </header>
      {view.reports.length > 0 && (
        <ReportStrip reports={view.reports} modelAvailable={view.modelChain.available} onExtract={onExtract} />
      )}
    </>
  )
}

interface ReportStripProps {
  reports: ReportRecord[]
  modelAvailable: boolean
  onExtract(report: ReportRecord, force?: boolean): void
}

/** S1 通知 chip 四态（契约 2.1）：IM 已推/未推、webhook 降级、均未配置 */
function NotifyChip({ notify }: { notify: BoardView['notify'] }) {
  if (!notify.configured) return <span className="chip notify-chip warn">推送未配置</span>
  if (notify.imConfigured) {
    return notify.lastPushedReport ? (
      <span className="chip notify-chip">已推送 · {notify.lastPushedReport}</span>
    ) : (
      <span className="chip notify-chip warn">已配置 · 未推送</span>
    )
  }
  return <span className="chip notify-chip warn">未配置飞书 · 文本摘要推送</span>
}

/** S1b 报告状态条：状态四态 + 抽取/重试/两段式重新抽取；与 S-L 状态点同源（G14） */
function ReportStrip({ reports, modelAvailable, onExtract }: ReportStripProps) {
  const extracting = reports.some((report) => report.status === 'extracting')
  return (
    <section className="report-strip" aria-label="报告状态">
      {extracting && (
        <p className="extract-live" aria-live="polite">
          {EXTRACTING_MESSAGE}
        </p>
      )}
      <ul className="report-strip-list">
        {reports.map((report) => (
          <ReportStripItem key={report.id} report={report} modelAvailable={modelAvailable} onExtract={onExtract} />
        ))}
      </ul>
    </section>
  )
}

function ReportStripItem({
  report,
  modelAvailable,
  onExtract,
}: {
  report: ReportRecord
  modelAvailable: boolean
  onExtract(report: ReportRecord, force?: boolean): void
}) {
  // 两段式重新抽取（G3）：首点变「确认重新抽取」+ 删除范围提示，失焦或 3 秒未点自动还原
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
            <span className="force-hint">{REEXTRACT_HINT}</span>
            <button type="button" className="extract-btn" onClick={confirmForce}>
              确认重新抽取
            </button>
          </span>
        ) : (
          <button type="button" className="extract-btn" onClick={arm} onBlur={() => setArmed(false)}>
            重新抽取
          </button>
        ))}
    </li>
  )
}
