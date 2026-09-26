import { useCallback, useEffect, useState } from 'react'

export interface StoredActionState {
  status: 'pending' | 'accepted' | 'rejected' | 'executed'
  executedNote?: string
}

export type StoredActionMap = Record<string, StoredActionState>

export interface ActionPatchInput {
  status: StoredActionState['status']
  executedNote?: string
  text?: string
  dimension?: string
  period?: string
}

/**
 * 行动状态后端事实源（M3）：初始 GET /api/actions；变更 PUT + 乐观更新；
 * 失败回滚为服务器状态并置 error（行内提示，GRILL 决议 6）。
 */
export function useActionStore(): {
  store: StoredActionMap
  setAction: (actionId: string, patch: ActionPatchInput, persist?: boolean) => void
  error: boolean
} {
  const [store, setStore] = useState<StoredActionMap>({})
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/actions')
      .then((res) => (res.ok ? res.json() : {}))
      .then((fetched) => {
        if (!cancelled && fetched && typeof fetched === 'object') setStore(fetched as StoredActionMap)
      })
      .catch(() => {
        /* 无后端（纯前端 dev）保持空 store */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setAction = useCallback((actionId: string, patch: ActionPatchInput, persist = true) => {
    setStore((prev) => ({
      ...prev,
      [actionId]: {
        status: patch.status,
        ...(patch.executedNote !== undefined
          ? { executedNote: patch.executedNote }
          : prev[actionId]?.executedNote !== undefined
            ? { executedNote: prev[actionId].executedNote }
            : {}),
      },
    }))
    if (!persist) return // 演示回退（无期次）：仅本地态，不落库（REVIEW cycle 3）
    fetch(`/api/actions/${encodeURIComponent(actionId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setError(false)
      })
      .catch(() => {
        setError(true)
        fetch('/api/actions')
          .then((res) => res.json())
          .then((s) => setStore(s as StoredActionMap))
          .catch(() => {
            /* 回滚失败保持现状 */
          })
      })
  }, [])

  return { store, setAction, error }
}
