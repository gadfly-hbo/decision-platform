import { useCallback, useEffect, useState } from 'react'
import type { ProjectSummary } from './data'

export interface ProjectsState {
  projects: ProjectSummary[]
  loading: boolean
  /** 拉取失败 → 明确错误态（M6：不回退演示，S7 退役） */
  error: boolean
  setProjects(updater: (prev: ProjectSummary[]) => ProjectSummary[]): void
  refresh(): Promise<ProjectSummary[] | null>
}

/**
 * 项目列表数据源（M6）：默认 GET /api/projects；
 * 注入 initial（AppProps.projects，测试/嵌入用）时直接使用、不再拉取。
 */
export function useProjects(initial?: ProjectSummary[]): ProjectsState {
  const [projects, setProjects] = useState<ProjectSummary[]>(initial ?? [])
  const [loading, setLoading] = useState(!initial)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (initial) return
    let cancelled = false
    fetch('/api/projects')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ projects: ProjectSummary[] }>
      })
      .then((fetched) => {
        if (!cancelled && fetched && Array.isArray(fetched.projects)) {
          setProjects(fetched.projects)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [initial])

  const refresh = useCallback(async (): Promise<ProjectSummary[] | null> => {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const fetched = (await res.json()) as { projects?: ProjectSummary[] }
      // 形状校验：畸形响应不腐蚀列表状态（与初始拉取同标准）
      if (!Array.isArray(fetched.projects)) return null
      setProjects(fetched.projects)
      setError(false)
      return fetched.projects
    } catch {
      return null
    }
  }, [])

  const update = useCallback((updater: (prev: ProjectSummary[]) => ProjectSummary[]) => {
    setProjects((prev) => updater(prev))
  }, [])

  return { projects, loading, error, setProjects: update, refresh }
}
