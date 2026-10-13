import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardView } from './data'

export interface ProjectBoardState {
  /** null = 加载中（渲染骨架）或无当前项目 */
  view: BoardView | null
  loading: boolean
  /** 拉取失败 → 明确错误态（M6：不回退演示） */
  error: boolean
  setView(view: BoardView): void
  refresh(): Promise<BoardView | null>
}

const EXTRACT_POLL_MS = 2500

/**
 * 当前项目 board 数据源（M6）：GET /api/projects/:id/board；
 * 注入 initial（AppProps.data，测试/嵌入用）且项目匹配时直接使用、不拉取不轮询。
 * 存在抽取中报告时自动轮询刷新（S10：抽取中→done 可见）。
 */
export function useProjectBoard(projectId: string | null, initial?: BoardView): ProjectBoardState {
  const injected = Boolean(initial && initial.project.id === projectId)
  const [view, setView] = useState<BoardView | null>(injected && initial ? initial : null)
  const [loading, setLoading] = useState(!injected && projectId !== null)
  const [error, setError] = useState(false)

  const refresh = useCallback(async (): Promise<BoardView | null> => {
    if (!projectId) return null
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/board`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const fetched = (await res.json()) as BoardView
      setView(fetched)
      setError(false)
      return fetched
    } catch {
      setError(true)
      return null
    }
  }, [projectId])

  useEffect(() => {
    if (injected) return
    if (!projectId) {
      setView(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setView(null)
    setError(false)
    setLoading(true)
    fetch(`/api/projects/${encodeURIComponent(projectId)}/board`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<BoardView>
      })
      .then((fetched) => {
        if (!cancelled && fetched && Array.isArray(fetched.actionItems)) {
          setView(fetched)
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
  }, [projectId, injected])

  // 抽取中轮询（仅真实拉取模式）：任一报告 extracting → 周期刷新直到完成
  const pollingRef = useRef(false)
  useEffect(() => {
    if (injected || !view) return
    const extracting = view.reports.some((report) => report.status === 'extracting')
    if (!extracting) {
      pollingRef.current = false
      return
    }
    if (pollingRef.current) return
    pollingRef.current = true
    const timer = setInterval(() => {
      void refresh().then((next) => {
        if (!next || !next.reports.some((report) => report.status === 'extracting')) {
          pollingRef.current = false
          clearInterval(timer)
        }
      })
    }, EXTRACT_POLL_MS)
    return () => {
      pollingRef.current = false
      clearInterval(timer)
    }
  }, [view, injected, refresh])

  return { view, loading, error, setView, refresh }
}
