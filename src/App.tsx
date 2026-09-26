import { useEffect, useState } from 'react'
import './App.css'
import { sortConclusions } from './data'
import type { ActionStatus, DashboardData } from './data'
import { useDashboardData } from './useDashboardData'
import { ConclusionCard } from './components/ConclusionCard'
import { ActionSummary } from './components/ActionSummary'

export interface AppProps {
  /** 数据边界缝：注入即直接使用（测试/嵌入），不拉取后端；缺省从 /api/dashboard 拉取 */
  data?: DashboardData
}

const initialActionStatus = (data: DashboardData): Record<string, ActionStatus> =>
  Object.fromEntries(
    data.conclusions.flatMap((conclusion) =>
      conclusion.actions.map((action) => [action.id, 'pending' as ActionStatus]),
    ),
  )

export default function App({ data: injected }: AppProps = {}) {
  const data = useDashboardData(injected)
  const conclusions = sortConclusions(data.conclusions)
  const metricById = new Map(data.metrics.map((metric) => [metric.id, metric]))
  const seriesById = new Map(data.series.map((series) => [series.metricId, series]))
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(conclusions.length > 0 ? [conclusions[0].id] : []),
  )
  const [actionStatus, setActionStatus] = useState<Record<string, ActionStatus>>(() =>
    initialActionStatus(data),
  )

  // 数据源切换（演示回退 → 真实计算）时，展开态与行动状态按新数据重置
  const dataKey = data.period ?? data.window
  useEffect(() => {
    setExpandedIds(new Set(conclusions.length > 0 ? [conclusions[0].id] : []))
    setActionStatus(initialActionStatus(data))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey])

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

  const setActionStatusOf = (actionId: string, status: ActionStatus) =>
    setActionStatus((prev) => ({ ...prev, [actionId]: status }))

  return (
    <main className="app">
      <header className="overview">
        <h1 className="page-title">{data.title}</h1>
        <p className="overview-lede">{data.lede}</p>
        <p className="overview-meta">
          数据窗口 {data.window} · 更新于 {data.updatedAt}
          {data.isDemo && <span className="chip demo-chip">演示数据</span>}
        </p>
      </header>
      {conclusions.length === 0 ? (
        <div className="empty">
          <p className="empty-title">暂无需要拍板的结论</p>
          <p className="empty-hint">
            数据窗口内未触发任何规则；将最新周报 CSV 放入 data/raw/ 后刷新即可。
          </p>
        </div>
      ) : (
        <section aria-label="结论区">
          <ol className="conclusion-list">
            {conclusions.map((conclusion) => (
              <li key={conclusion.id}>
                <ConclusionCard
                  conclusion={conclusion}
                  expanded={expandedIds.has(conclusion.id)}
                  onToggle={() => toggle(conclusion.id)}
                  metricFor={(id) => metricById.get(id)}
                  seriesFor={(id) => seriesById.get(id)}
                  actionStatus={actionStatus}
                  onActionStatusChange={setActionStatusOf}
                />
              </li>
            ))}
          </ol>
        </section>
      )}
      <ActionSummary
        conclusions={conclusions}
        actionStatus={actionStatus}
        onActionStatusChange={setActionStatusOf}
      />
    </main>
  )
}
