import { REPORT_STATUS_LABELS, formatDateTime, reportDisplayName } from '../data'
import type { ReportRecord } from '../data'

export type ReportFilter = 'all' | 'manual' | number

interface ReportNavProps {
  reports: ReportRecord[]
  selected: ReportFilter
  onSelect(value: ReportFilter): void
}

/** S-L 左栏报告导航（G13）：固定项「全部/人工补充」+ 报告列表；点击 = 主区过滤器报告维聚焦联动 */
export function ReportNav({ reports, selected, onSelect }: ReportNavProps) {
  return (
    <aside className="side-nav">
      <nav aria-label="报告导航">
        <button type="button" className="side-item" aria-pressed={selected === 'all'} onClick={() => onSelect('all')}>
          <span className="side-item-name">全部</span>
        </button>
        <button type="button" className="side-item" aria-pressed={selected === 'manual'} onClick={() => onSelect('manual')}>
          <span className="side-item-name">人工补充</span>
        </button>
        <div className="side-list">
          {reports.length === 0 && <p className="side-empty">尚无报告：将 .md/.txt 放入 data/raw/ 后自动出现。</p>}
          {reports.map((report) => (
            <button
              type="button"
              key={report.id}
              className="side-item"
              aria-pressed={selected === report.id}
              onClick={() => onSelect(report.id)}
            >
              <span className="side-item-name">{reportDisplayName(report.filename)}</span>
              <span className="side-item-meta">
                {formatDateTime(report.importedAt)} ·{' '}
                <span className="status-cell">
                  <i className={`status-dot sd-${report.status}`} aria-hidden="true" />
                  {REPORT_STATUS_LABELS[report.status]}
                </span>
              </span>
            </button>
          ))}
        </div>
      </nav>
    </aside>
  )
}
