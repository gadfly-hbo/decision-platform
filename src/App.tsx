import { useEffect, useRef, useState } from 'react'
import './App.css'
import type { BoardView, ProjectSummary } from './data'
import { displayEvidenceLevel, reportDisplayName } from './data'
import { useProjects } from './useProjects'
import { useProjectBoard } from './useProjectBoard'
import { useBoardStore } from './useBoardStore'
import { WorkbenchShell } from './components/WorkbenchShell'
import { RunDrawer } from './components/RunDrawer'
import { ProjectNav } from './components/ProjectNav'
import { OverviewHeader } from './components/OverviewHeader'
import { ActionFilters, type EvidenceFilter, type PriorityFilter, type ReportFilter, type StatusFilter } from './components/ActionFilters'
import { ActionItemCard } from './components/ActionItemCard'

const ACTIVE_PROJECT_KEY = 'dp.activeProjectId'

/** 无项目态下 S-R 抽屉的模型链占位（账本全局可用；模型链随项目 board 加载后呈现） */
const EMPTY_MODEL_CHAIN = { available: true, providers: [] }

export interface AppProps {
  /** 数据边界缝（测试/嵌入）：注入即直接使用，不拉取后端；data 单独注入时项目列表由其派生 */
  projects?: ProjectSummary[]
  data?: BoardView
}

function readActiveProjectId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY)
  } catch {
    return null
  }
}

export default function App({ projects: injectedProjects, data: injectedBoard }: AppProps = {}) {
  const injected = injectedProjects !== undefined || injectedBoard !== undefined
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    if (injected) return injectedBoard?.project.id ?? injectedProjects?.[0]?.id ?? null
    return readActiveProjectId() // G7'：刷新/重启回到最后项目
  })
  const projects = useProjects(
    injectedProjects ?? (injectedBoard ? [summaryOf(injectedBoard)] : undefined),
  )
  const board = useProjectBoard(activeProjectId, injectedBoard)
  const store = useBoardStore({ projectId: activeProjectId, board, projects })
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [evidenceFilter, setEvidenceFilter] = useState<EvidenceFilter>('all')
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all')
  const [reportFilter, setReportFilter] = useState<ReportFilter>('all')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerBtnRef = useRef<HTMLButtonElement>(null)

  // G7'：当前项目持久化；项目切换时重置报告过滤与展开态（报告 id 属于旧项目）
  useEffect(() => {
    try {
      if (activeProjectId) window.localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId)
      else window.localStorage.removeItem(ACTIVE_PROJECT_KEY)
    } catch {
      /* localStorage 不可用（隐私模式等）只丢记忆，不影响功能 */
    }
  }, [activeProjectId])

  useEffect(() => {
    setReportFilter('all')
    setExpandedIds(new Set())
  }, [activeProjectId])

  // 无记忆但已有项目（localStorage 被清/另一端新建）→ 默认列表首个
  useEffect(() => {
    if (!activeProjectId && projects.projects.length > 0) {
      setActiveProjectId(projects.projects[0].id)
    }
  }, [activeProjectId, projects.projects])

  const selectProject = (id: string) => setActiveProjectId(id)

  const handleDeleteProject = async (id: string) => {
    const remaining = await store.deleteProject(id)
    if (remaining === null) return
    if (id === activeProjectId) {
      setActiveProjectId(remaining[0]?.id ?? null) // G7'：删除后回退列表首个或无项目空态
    }
  }

  const handleCreateProject = async (title: string, purpose?: string) => {
    const created = await store.createProject(title, purpose)
    if (created) setActiveProjectId(created.id) // 创建成功后切换为新项目
    return created
  }

  const closeDrawer = () => {
    setDrawerOpen(false)
    drawerBtnRef.current?.focus() // 关闭后焦点回开关钮（非模态抽屉语义）
  }

  const view = board.view

  if (projects.loading && projects.projects.length === 0) {
    // 首屏加载：骨架，不显示空态/错误态（避免闪烁误判）
    return <LoadingShell />
  }

  if (projects.error && projects.projects.length === 0) {
    return (
      <WorkbenchShell reportNav={null} runDrawer={drawerOpen ? <RunDrawer modelChain={EMPTY_MODEL_CHAIN} onClose={closeDrawer} /> : undefined}>
        <div className="empty" role="alert">
          <p className="empty-title">项目列表加载失败</p>
          <p className="empty-hint">请检查后端服务后重试。</p>
          <button type="button" className="primary-btn" onClick={() => void projects.refresh()}>
            重试
          </button>
        </div>
      </WorkbenchShell>
    )
  }

  if (!activeProjectId) {
    // S8-① 无项目空态：主区引导卡（含「运行详情」开关钮——账本是全局的，G4'）
    return (
      <WorkbenchShell
        reportNav={
          <ProjectNav
            projects={projects.projects}
            activeProjectId={null}
            onSelect={selectProject}
            onCreateProject={handleCreateProject}
            onUpdateProject={store.updateProject}
            onDeleteProject={handleDeleteProject}
          />
        }
        runDrawer={drawerOpen ? <RunDrawer modelChain={EMPTY_MODEL_CHAIN} onClose={closeDrawer} /> : undefined}
      >
        <div className="empty project-guide">
          <div className="overview-row">
            <div className="overview-heading">
              <h2 className="page-title">尚无项目</h2>
              <p className="overview-lede">新建一个项目，在项目内上传报告即可生成看板。</p>
            </div>
            <button
              ref={drawerBtnRef}
              type="button"
              className="drawer-toggle"
              aria-expanded={drawerOpen}
              aria-controls="run-drawer"
              onClick={() => setDrawerOpen((open) => !open)}
            >
              运行详情
            </button>
          </div>
          <GuideCreateForm onCreateProject={handleCreateProject} />
        </div>
        {store.error && (
          <p className="action-error" role="alert">
            保存失败，已恢复为服务器状态
          </p>
        )}
      </WorkbenchShell>
    )
  }

  if (!view) {
    if (board.error) {
      return (
        <WorkbenchShell
          reportNav={
            <ProjectNav
              projects={projects.projects}
              activeProjectId={activeProjectId}
              onSelect={selectProject}
              onCreateProject={handleCreateProject}
              onUpdateProject={store.updateProject}
              onDeleteProject={handleDeleteProject}
            />
          }
          runDrawer={undefined}
        >
          <div className="empty" role="alert">
            <p className="empty-title">看板加载失败</p>
            <p className="empty-hint">请检查后端服务后重试。</p>
            <button type="button" className="primary-btn" onClick={() => void board.refresh()}>
              重试
            </button>
          </div>
        </WorkbenchShell>
      )
    }
    return <LoadingShell />
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

  return (
    <WorkbenchShell
      reportNav={
        <ProjectNav
          projects={projects.projects}
          activeProjectId={activeProjectId}
          onSelect={selectProject}
          onCreateProject={handleCreateProject}
          onUpdateProject={store.updateProject}
          onDeleteProject={handleDeleteProject}
        />
      }
      runDrawer={drawerOpen ? <RunDrawer modelChain={view.modelChain} onClose={closeDrawer} /> : undefined}
    >
      <OverviewHeader
        view={view}
        drawerOpen={drawerOpen}
        drawerBtnRef={drawerBtnRef}
        onToggleDrawer={() => setDrawerOpen((open) => !open)}
        onUpload={store.uploadReports}
        onExtract={store.extractReport}
        modelAvailable={view.modelChain.available}
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
        onCreateManual={store.createManual}
      />
      <section className="action-section" aria-label="行动项列表">
        {items.length === 0 && view.reports.some((report) => report.status === 'done') ? (
          <div className="empty">
            <p className="empty-title">该报告未抽取到行动项</p>
            <p className="empty-hint">报告已解析完成，但未包含可执行建议；可尝试重新生成或检查报告内容。</p>
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
                  onToggle={() => toggle(item.id)}
                  onAdopt={store.adopt}
                  onDismiss={store.dismiss}
                  onBackfill={store.backfill}
                  onCreateTask={store.createTask}
                  onPatchTask={store.patchTask}
                  onSaveFeedback={store.saveFeedback}
                />
              </li>
            ))}
          </ol>
        )}
        {store.error && (
          <p className="action-error" role="alert">
            保存失败，已恢复为服务器状态
          </p>
        )}
      </section>
    </WorkbenchShell>
  )
}

function LoadingShell() {
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

/** S8-① 引导卡内的新建项目表单（与 S-L 同构；创建成功后切换并由 App 收起） */
function GuideCreateForm({ onCreateProject }: { onCreateProject(title: string, purpose?: string): Promise<ProjectSummary | null> }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button type="button" className="primary-btn" onClick={() => setOpen(true)}>
        ＋ 新建项目
      </button>
    )
  }
  return (
    <GuideForm
      onCancel={() => setOpen(false)}
      onSubmit={async (title, purpose) => {
        const created = await onCreateProject(title, purpose)
        if (created) setOpen(false)
        return created !== null
      }}
    />
  )
}

function GuideForm({
  onSubmit,
  onCancel,
}: {
  onSubmit(title: string, purpose?: string): Promise<boolean>
  onCancel(): void
}) {
  const [title, setTitle] = useState('')
  const [purpose, setPurpose] = useState('')
  const [nameError, setNameError] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (title.trim() === '') {
      setNameError(true)
      return
    }
    setSubmitting(true)
    await onSubmit(title.trim(), purpose.trim() || undefined)
    setSubmitting(false)
  }

  return (
    <form
      className="project-form"
      aria-label="新建项目"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="form-row">
        <label className="form-label">名称 *</label>
        <input
          className="form-input"
          type="text"
          aria-label="名称"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value)
            if (nameError) setNameError(false)
          }}
        />
        {nameError && (
          <p role="alert" className="form-error">
            请填写名称
          </p>
        )}
      </div>
      <div className="form-row">
        <label className="form-label">目的</label>
        <input
          className="form-input"
          type="text"
          placeholder="这个看板跟踪什么业务"
          aria-label="目的"
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="primary-btn" disabled={submitting}>
          创建
        </button>
        <button type="button" disabled={submitting} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}

/** BoardView → 列表条目投影（data 注入且未传 projects 时派生） */
function summaryOf(view: BoardView): ProjectSummary {
  return {
    id: view.project.id,
    title: view.project.title,
    purpose: view.project.purpose,
    createdAt: '',
    updatedAt: '',
    actionCounts: view.stats,
    lastActivity: '',
  }
}
