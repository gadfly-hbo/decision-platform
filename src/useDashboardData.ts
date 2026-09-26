import { useEffect, useState } from 'react'
import { demoData } from './data'
import type { DashboardData } from './data'

const demoFallback = (): DashboardData => ({ ...demoData, isDemo: true })

/**
 * 数据获取缝：默认从 /api/dashboard 拉取真实计算结果；
 * 注入 initial（AppProps.data，测试/嵌入用）时直接使用、不再拉取；
 * 拉取失败回退演示数据并标注 isDemo（PRD story 14）。
 * 初始渲染即有数据（演示回退），后端就绪后无缝替换，避免空屏。
 */
export function useDashboardData(initial?: DashboardData): DashboardData {
  const [data, setData] = useState<DashboardData>(() => initial ?? demoFallback())

  useEffect(() => {
    if (initial) return
    let cancelled = false
    fetch('/api/dashboard')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<DashboardData>
      })
      .then((fetched) => {
        if (!cancelled && fetched && Array.isArray(fetched.conclusions)) setData(fetched)
      })
      .catch(() => {
        /* 保持演示回退 */
      })
    return () => {
      cancelled = true
    }
  }, [initial])

  return data
}
