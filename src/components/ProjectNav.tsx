import { useEffect, useRef, useState } from 'react'
import { formatDateTime } from '../data'
import type { ProjectSummary } from '../data'
import type { ProjectPatchInput } from '../useBoardStore'

export const DELETE_PROJECT_BODY = '项目及其报告文件将一并删除，不可恢复。'
export const PROJECT_NAME_REQUIRED_ERROR = '请填写名称'
export const NO_PROJECTS_TEXT = '尚无项目——新建一个开始。'

interface ProjectNavProps {
  projects: ProjectSummary[]
  activeProjectId: string | null
  onSelect(id: string): void
  onCreateProject(title: string, purpose?: string): Promise<ProjectSummary | null>
  onUpdateProject(id: string, patch: ProjectPatchInput): Promise<boolean>
  onDeleteProject(id: string): Promise<unknown>
}

/** S-L 左栏项目导航（v5 2.15）：新建/编辑 inline 表单 + 项目列表（计数/活动/切换高亮/删除 ×）+ S14 删除确认弹窗 */
export function ProjectNav({
  projects,
  activeProjectId,
  onSelect,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
}: ProjectNavProps) {
  const [createOpen, setCreateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null) // S14 关闭后焦点回 ×

  return (
    <aside className="side-nav">
      <nav aria-label="项目导航">
        <button
          type="button"
          className="task-add-btn project-create-toggle"
          aria-expanded={createOpen}
          onClick={() => setCreateOpen((open) => !open)}
        >
          ＋ 新建项目
        </button>
        {createOpen && (
          <ProjectForm
            submitLabel="创建"
            onCancel={() => setCreateOpen(false)}
            onSubmit={async (title, purpose) => {
              const created = await onCreateProject(title, purpose)
              if (created) setCreateOpen(false) // 创建成功后切换为新项目（App 处理）并收起
              return created !== null
            }}
          />
        )}
        {projects.length === 0 && !createOpen && <p className="side-empty">{NO_PROJECTS_TEXT}</p>}
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id} className="project-item">
              <button
                type="button"
                className="side-item"
                aria-pressed={project.id === activeProjectId}
                onClick={() => onSelect(project.id)}
              >
                <span className="side-item-name">{project.title}</span>
                <span className="side-item-meta">
                  <span className="chip val-chip project-count-chip">
                    行动项 {countOf(project)}
                  </span>
                  {project.lastActivity ? ` · ${formatDateTime(project.lastActivity)}` : ''}
                </span>
              </button>
              {project.id === activeProjectId && (
                <button
                  type="button"
                  className="project-mini-btn"
                  aria-label={`编辑 ${project.title}`}
                  onClick={() => setEditingId((current) => (current === project.id ? null : project.id))}
                >
                  编辑
                </button>
              )}
              <button
                type="button"
                className="project-mini-btn project-del-btn"
                aria-label={`删除 ${project.title}`}
                onClick={(event) => {
                  deleteTriggerRef.current = event.currentTarget
                  setDeleting(project)
                }}
              >
                ×
              </button>
              {editingId === project.id && (
                <ProjectForm
                  initial={project}
                  submitLabel="保存"
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (title, purpose) => {
                    const ok = await onUpdateProject(project.id, { title, purpose })
                    if (ok) setEditingId(null)
                    return ok
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </nav>
      {deleting && (
        <DeleteProjectDialog
          project={deleting}
          returnFocusRef={deleteTriggerRef}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await onDeleteProject(deleting.id)
          }}
        />
      )}
    </aside>
  )
}

function countOf(project: ProjectSummary): number {
  const c = project.actionCounts
  return c.suggested + c.adopted + c.dismissed
}

interface ProjectFormProps {
  initial?: { title: string; purpose: string }
  submitLabel: string
  onSubmit(title: string, purpose?: string): Promise<boolean>
  onCancel(): void
}

/** 新建/编辑项目共用 inline 表单（名称必填/目的可选；Enter 提交、Esc 收起） */
function ProjectForm({ initial, submitLabel, onSubmit, onCancel }: ProjectFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [purpose, setPurpose] = useState(initial?.purpose ?? '')
  const [nameError, setNameError] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (title.trim() === '') {
      setNameError(true)
      return
    }
    setSubmitting(true)
    const ok = await onSubmit(title.trim(), purpose.trim() || undefined)
    setSubmitting(false)
    if (ok && !initial) {
      setTitle('')
      setPurpose('')
      setNameError(false)
    }
  }

  return (
    <form
      className="project-form"
      aria-label={initial ? '编辑项目' : '新建项目'}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="form-row">
        <label className="form-label">
          名称 *
        </label>
        <input
          className="form-input"
          type="text"
          value={title}
          aria-label="名称"
          onChange={(event) => {
            setTitle(event.target.value)
            if (nameError) setNameError(false)
          }}
        />
        {nameError && (
          <p role="alert" className="form-error">
            {PROJECT_NAME_REQUIRED_ERROR}
          </p>
        )}
      </div>
      <div className="form-row">
        <label className="form-label">
          目的
        </label>
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
          {submitLabel}
        </button>
        <button type="button" disabled={submitting} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}

interface DeleteProjectDialogProps {
  project: ProjectSummary
  returnFocusRef: React.RefObject<HTMLButtonElement | null>
  onConfirm(): Promise<void>
  onClose(): void
}

/** S14 删除项目确认弹窗（弹层之二）：打开聚焦 [取消]（破坏性操作安全位），关闭回 × 钮 */
function DeleteProjectDialog({ project, returnFocusRef, onConfirm, onClose }: DeleteProjectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal()
    else dialog.setAttribute('open', '')
    cancelBtnRef.current?.focus()
    const onCancel = (event: Event) => {
      event.preventDefault()
      close()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => dialog.removeEventListener('cancel', onCancel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = () => {
    const dialog = dialogRef.current
    if (dialog) {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close()
      else dialog.removeAttribute('open')
    }
    returnFocusRef.current?.focus() // 关闭后焦点回触发的 × 钮
    onClose()
  }

  const confirm = async () => {
    setSubmitting(true)
    await onConfirm()
    setSubmitting(false)
    close()
  }

  return (
    <dialog ref={dialogRef} className="dismiss-dialog delete-project-dialog" aria-labelledby="delete-project-title">
      <h2 id="delete-project-title" className="dismiss-dialog-title">
        删除项目
      </h2>
      <p className="card-summary">{project.title}</p>
      <p className="delete-project-body">{DELETE_PROJECT_BODY}</p>
      <div className="dismiss-dialog-actions">
        <button type="button" className="danger-btn" disabled={submitting} onClick={() => void confirm()}>
          确认删除
        </button>
        <button type="button" ref={cancelBtnRef} disabled={submitting} onClick={close}>
          取消
        </button>
      </div>
    </dialog>
  )
}
