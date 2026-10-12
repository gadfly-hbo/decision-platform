import { useRef, useState } from 'react'
import './App.css'
import type { BoardView } from './data'
import { displayEvidenceLevel, reportDisplayName } from './data'
import { useDashboardData } from './useDashboardData'
import { useBoardStore } from './useBoardStore'
import { WorkbenchShell } from './components/WorkbenchShell'
import { RunDrawer } from './components/RunDrawer'
import { ReportNav, type ReportFilter } from './components/ReportNav'
import { OverviewHeader } from './components/OverviewHeader'
import { ActionFilters, type EvidenceFilter, type PriorityFilter, type StatusFilter } from './components/ActionFilters'
import { ActionItemCard } from './components/ActionItemCard'

export interface AppProps {
  /** 数据边界缝：注入即直接使用（测试/嵌入），不拉取后端；缺省从 /api/dashboard 拉取 */
  data?: BoardView
}

export default function App({ data: injected }: AppProps = {}) {
  const dashboard = useDashboardData(injected)
  const board = useBoardStore(dashboard)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilter>('all')
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all')
  const [reportFilter, setReportFilter] = useState<ReportFilter>('all')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerBtnRef = useRef<HTMLButtonElement>(null)

  const view = dashboard.view

  if (!view) {
    // S10 首屏加载：概览头 + 3 张卡片骨架，不显示空态/错误态（避免闪烁误判）
    return (
      <div className="workbench">
        <main className="wb-main" aria-busy="true">
          <div className="skeleton skeleton-header" />
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-card" />
        </main>
      </div>
    )
  }

  const items = view.actionItems
  const reportNameById = new Map(view.reports.map((report) => [report.id, reportDisplayName(report.filename)]))
  const visibleItems = items.filter(
    (item) =>
      (statusFilter === 'all' || item.status === statusFilter) &&
      (evidenceFilter === 'all' || displayEvidenceLevel(item) === evidenceFilter) &&
      (priorityFilter === 'all' || item.priority === priorityFilter) &&
      (reportFilter === 'all' ||
        (reportFilter === 'manual' ? item.sourceKind === 'manual' : item.reportId === reportFilter)),
  )

  const toggle = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })

  const closeDrawer = () => {
    setDrawerOpen(false)
    drawerBtnRef.current?.focus() // 关闭后焦点回开关钮（非模态抽屉语义）
  }

  return (
    <WorkbenchShell
      reportNav={<ReportNav reports={view.reports} selected={reportFilter} onSelect={setReportFilter} />}
      runDrawer={drawerOpen ? <RunDrawer modelChain={view.modelChain} onClose={closeDrawer} /> : undefined}
    >
      <OverviewHeader
        view={view}
        drawerOpen={drawerOpen}
        drawerBtnRef={drawerBtnRef}
        onToggleDrawer={() => setDrawerOpen((open) => !open)}
        onExtract={board.extractReport}
      />
      <ActionFilters
        items={items}
        reports={view.reports}
        status={statusFilter}
        evidence={evidenceFilter}
        priority={priorityFilter}
        report={reportFilter}
        onStatusChange={setStatusFilter}
        onEvidenceChange={setEvidenceFilter}
        onPriorityChange={setPriorityFilter}
        onReportChange={setReportFilter}
        onCreateManual={board.createManual}
      />
      <section className="action-section" aria-label="行动项列表">
        {items.length === 0 && view.reports.some((report) => report.status === 'done') && !view.isDemo ? (
          <div className="empty">
            <p className="empty-title">该报告未抽取到行动项</p>
            <p className="empty-hint">报告已解析完成，但未包含可执行建议；可尝试重新抽取或检查报告内容。</p>
          </div>
        ) : visibleItems.length === 0 && items.length > 0 ? (
          <p className="empty-lite">该过滤条件下暂无行动项</p>
        ) : (
          <ol className="action-list">
            {visibleItems.map((item) => (
              <li key={item.id}>
                <ActionItemCard
                  item={item}
                  reportName={item.reportId !== null ? (reportNameById.get(item.reportId) ?? null) : null}
                  expanded={expandedIds.has(item.id)}
                  demo={view.isDemo}
                  onToggle={() => toggle(item.id)}
                  onAdopt={board.adopt}
                  onDismiss={board.dismiss}
                  onBackfill={board.backfill}
                  onCreateTask={board.createTask}
                  onPatchTask={board.patchTask}
                  onSaveFeedback={board.saveFeedback}
                />
              </li>
            ))}
          </ol>
        )}
        {board.error && (
          <p className="action-error" role="alert">
            保存失败，已恢复为服务器状态
          </p>
        )}
      </section>
    </WorkbenchShell>
  )
}
