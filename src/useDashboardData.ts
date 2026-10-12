import { useCallback, useEffect, useState } from 'react'
import { demoBoardView } from './data'
import type { BoardView } from './data'

export interface DashboardDataState {
  /** null = 首屏加载中（渲染骨架，不显空态/错误态） */
  view: BoardView | null
  loading: boolean
  setView(view: BoardView): void
  refresh(): Promise<BoardView | null>
}

/**
 * 数据获取缝（M5）：默认从 /api/dashboard 拉取 BoardView；
 * 注入 initial（AppProps.data，测试/嵌入用）时直接使用、不再拉取；
 * 拉取失败回退演示数据（isDemo，前端演示回退）；isDemo 载荷空列表时注入 3 条演示行动项。
 */
export function useDashboardData(initial?: BoardView): DashboardDataState {
  const [view, setView] = useState<BoardView | null>(initial ? adoptDemo(initial) : null)
  const [loading, setLoading] = useState(!initial)

  useEffect(() => {
    if (initial) return
    let cancelled = false
    fetch('/api/dashboard')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<BoardView>
      })
      .then((fetched) => {
        if (!cancelled && fetched && Array.isArray(fetched.actionItems)) {
          setView(adoptDemo(fetched))
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setView(demoBoardView)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [initial])

  const refresh = useCallback(async (): Promise<BoardView | null> => {
    try {
      const res = await fetch('/api/dashboard')
      if (!res.ok) return null
      const fetched = (await res.json()) as BoardView
      setView(adoptDemo(fetched))
      return fetched
    } catch {
      return null
    }
  }, [])

  return { view, loading, setView, refresh }
}

/** 演示回退：isDemo 且行动项为空时使用固定演示样例（notify/modelChain 仍取真实配置） */
function adoptDemo(view: BoardView): BoardView {
  if (view.isDemo && view.actionItems.length === 0) {
    return { ...view, actionItems: demoBoardView.actionItems, stats: demoBoardView.stats }
  }
  return view
}
